// codeep-action entry point. Resolves the PR context, fetches the changed
// files, runs `codeep review <files> --json --fail-on <level>`, posts a sticky
// PR comment + inline annotations, and exits with the reviewer's code (so the
// PR check passes/fails per --fail-on). Zero deps — Node 20 built-ins only.

import { readFileSync, appendFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  MARKER, validateFailOn, parseEvent, filterChangedFiles, sanitizeFiles,
  buildAnnotations, formatComment,
} from './lib.mjs';

const execFileP = promisify(execFile);
const API = 'https://api.github.com';

const notice = (m) => console.log(`::notice::${m}`);
const warn = (m) => console.log(`::warning::${m}`);
const error = (m) => console.log(`::error::${m}`);

function ghHeaders(token, write = false) {
  const h = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'codeep-action',
  };
  if (write) h['Content-Type'] = 'application/json';
  return h;
}

function setOutput(name, value) {
  const f = process.env.GITHUB_OUTPUT;
  if (!f) return; // local run — no-op so the script stays runnable off-CI
  try { appendFileSync(f, `${name}=${value}\n`); } catch { /* best-effort */ }
}

function skip(reason) {
  notice(reason);
  setOutput('skipped', 'true');
  setOutput('score', '');
  setOutput('total-issues', '0');
  setOutput('exit-code', '0');
  process.exit(0);
}

function fail(message) {
  error(message);
  setOutput('skipped', 'false');
  setOutput('score', '');
  setOutput('total-issues', '0');
  setOutput('exit-code', '1');
  process.exit(1);
}

async function listChangedFiles(owner, repo, prNumber, token) {
  const files = [];
  for (let page = 1; ; page++) {
    const url = `${API}/repos/${owner}/${repo}/pulls/${prNumber}/files?per_page=100&page=${page}`;
    const res = await fetch(url, { headers: ghHeaders(token) });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      fail(`Failed to list PR files: ${res.status} ${body.slice(0, 300)}`);
    }
    const batch = await res.json();
    files.push(...batch);
    if (batch.length < 100) break;
  }
  return files;
}

// List + find the marked comment, then PATCH it (or POST a new one). Best-effort:
// a fork PR's read-only token makes the write 403, which we warn-and-skip so the
// annotations + exit-code gate still stand.
async function upsertSticky(owner, repo, prNumber, body, token) {
  try {
    let existingId = null;
    for (let page = 1; ; page++) {
      const url = `${API}/repos/${owner}/${repo}/issues/${prNumber}/comments?per_page=100&page=${page}`;
      const res = await fetch(url, { headers: ghHeaders(token) });
      if (!res.ok) { warn(`Comment list failed: ${res.status}`); return; }
      const batch = await res.json();
      const hit = batch.find((c) => typeof c.body === 'string' && c.body.includes(MARKER));
      if (hit) { existingId = hit.id; break; }
      if (batch.length < 100) break;
    }
    const target = existingId
      ? { url: `${API}/repos/${owner}/${repo}/issues/comments/${existingId}`, method: 'PATCH' }
      : { url: `${API}/repos/${owner}/${repo}/issues/${prNumber}/comments`, method: 'POST' };
    const res = await fetch(target.url, {
      method: target.method,
      headers: ghHeaders(token, true),
      body: JSON.stringify({ body }),
    });
    if (res.status === 403) {
      warn('Cannot post the PR comment — GITHUB_TOKEN is read-only on fork PRs. '
        + 'Findings still appear as inline annotations and in the check status.');
      return;
    }
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      warn(`Comment upsert failed: ${res.status} ${t.slice(0, 200)}`);
    }
  } catch (e) {
    warn(`Comment upsert error: ${e.message}`);
  }
}

async function main() {
  const version = process.env.INPUT_CODEEP_VERSION || 'latest';
  const failOn = validateFailOn(process.env.INPUT_FAIL_ON);
  const wantComment = process.env.INPUT_COMMENT !== 'false';
  const wantAnnotate = process.env.INPUT_ANNOTATE !== 'false';
  const overrideFiles = (process.env.INPUT_FILES || '').trim();
  const maxAnnotations = parseInt(process.env.INPUT_MAX_ANNOTATIONS, 10) || 50;
  const maxPerFile = parseInt(process.env.INPUT_MAX_ISSUES_PER_FILE, 10) || 10;
  const token = process.env.GITHUB_TOKEN;

  // Resolve PR context from the event payload.
  let event;
  try {
    event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  } catch {
    skip('No readable event payload; skipping.');
  }
  const ctx = parseEvent(event, process.env.GITHUB_EVENT_NAME, process.env.GITHUB_REPOSITORY);
  if (!ctx) {
    skip(`Not a pull_request event (got '${process.env.GITHUB_EVENT_NAME}'); codeep-action only runs on PRs.`);
  }

  // Resolve the file list.
  let candidates;
  if (overrideFiles) {
    candidates = overrideFiles.split(/\s+/).filter(Boolean);
  } else {
    if (!token) fail('No GITHUB_TOKEN available to list PR files.');
    candidates = filterChangedFiles(await listChangedFiles(ctx.owner, ctx.repo, ctx.prNumber, token));
  }
  const files = sanitizeFiles(candidates);

  if (files.length === 0) {
    if (wantComment && token) {
      const body = `${MARKER}\n## Codeep Review\n\n✅ No reviewable changed files in this PR.`;
      await upsertSticky(ctx.owner, ctx.repo, ctx.prNumber, body, token);
    }
    skip('No reviewable changed files; skipping codeep review.');
  }

  // Run the reviewer with an args array (shell:false) + `--` + ./-prefix guard.
  const args = ['--yes', `codeep@${version}`, 'review', '--json', '--fail-on', failOn, '--', ...files];
  let stdout;
  let exitCode = 0;
  try {
    const r = await execFileP('npx', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, env: process.env });
    stdout = r.stdout;
  } catch (e) {
    // codeep exits non-zero BY DESIGN when issues trip the threshold; that's not
    // a run failure as long as it produced JSON. Distinguish the failure modes:
    //  - maxBuffer overflow: e.code is the string 'ERR_..._MAXBUFFER' and e.stdout
    //    is a TRUNCATED prefix — must NOT be parsed as "bad JSON" (infra failure).
    //  - spawn/install failure: no stdout at all (e.code may be 'ENOENT' etc.).
    if (e && e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
      fail('codeep review output exceeded the 32MB buffer; cannot parse the result. Scope the PR or raise the limit.');
    }
    stdout = e && e.stdout;
    if (!stdout) {
      fail(`codeep review failed to run: ${String((e && (e.stderr || e.message)) || '').slice(0, 500)}`);
    }
    // Produced JSON but exited non-zero → issues tripped the threshold. Clamp to
    // the documented 0/1 contract regardless of codeep's raw exit code.
    exitCode = 1;
  }

  let result;
  try {
    result = JSON.parse(stdout);
  } catch {
    fail('codeep review produced no parseable JSON on stdout.');
  }

  // Inline annotations.
  if (wantAnnotate) {
    const anns = buildAnnotations(result, { max: maxAnnotations });
    for (const a of anns) console.log(a);
    const total = (result.summary && result.summary.totalIssues) ?? (result.issues ? result.issues.length : 0);
    if (total > anns.length) notice(`codeep: ${total - anns.length} more issue(s) not annotated (see the PR comment).`);
  }

  // Sticky comment.
  if (wantComment && token) {
    const body = formatComment(result, { maxPerFile, failOn, version, prNumber: ctx.prNumber });
    await upsertSticky(ctx.owner, ctx.repo, ctx.prNumber, body, token);
  }

  // Outputs + exit. The gate is codeep's real exit code — never recomputed here.
  setOutput('skipped', 'false');
  setOutput('score', String(result.score ?? ''));
  setOutput('total-issues', String((result.summary && result.summary.totalIssues) ?? 0));
  setOutput('exit-code', String(exitCode));
  process.exit(exitCode);
}

main().catch((e) => {
  error(`codeep-action crashed: ${e && (e.stack || e.message) || e}`);
  process.exit(1);
});
