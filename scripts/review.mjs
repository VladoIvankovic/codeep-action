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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Run `npx codeep review ...` with retry resilience. `npx`'s fetch+install of
 * codeep on a fresh runner can flake transiently (network, registry), which
 * would otherwise fail a consumer's PR check for no real reason. Retry only the
 * "couldn't run at all" case (no stdout); a non-zero exit WITH JSON means codeep
 * ran and issues tripped the threshold (return immediately), and a maxBuffer
 * overflow is deterministic (fail fast).
 *
 * Returns { stdout, exitCode }. Calls fail()/process.exit on a fatal outcome.
 */
// Hard wall-clock bound on a single `codeep review` invocation. A custom rule
// in an untrusted PR's .codeep/review.json could be slow/catastrophic; without
// this the runner would hang until the job-level timeout. Generous for a real
// review, but fatal to a runaway one.
const REVIEW_TIMEOUT_MS = 180_000;

async function runCodeep(args, attempts = 3) {
  let last;
  for (let i = 1; i <= attempts; i++) {
    try {
      const r = await execFileP('npx', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: REVIEW_TIMEOUT_MS, env: process.env });
      return { stdout: r.stdout, exitCode: 0 };
    } catch (e) {
      if (e && e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
        fail('codeep review output exceeded the 32MB buffer; cannot parse the result. Scope the PR or raise the limit.');
      }
      // Timed out and killed (e.g. a catastrophic-backtracking custom rule, or a
      // very large PR). Do NOT retry — it would just time out again 3×.
      if (e && (e.killed === true || e.code === 'ETIMEDOUT')) {
        fail(`codeep review timed out after ${Math.round(REVIEW_TIMEOUT_MS / 1000)}s. A custom .codeep/review.json rule may be too slow (catastrophic backtracking), or the changed set is too large to review in one pass.`);
      }
      if (e && e.stdout) {
        // codeep ran and produced JSON but exited non-zero → issues tripped the
        // threshold. Clamp to the documented 0/1 contract; not a run failure.
        return { stdout: e.stdout, exitCode: 1 };
      }
      // No stdout → install/spawn failure. Likely transient; retry with backoff.
      last = e;
      if (i < attempts) {
        warn(`codeep run attempt ${i}/${attempts} failed (npx exit: ${e && e.code}); retrying…`);
        await sleep(2000 * i);
      }
    }
  }
  const detail = String((last && (last.stderr || last.message)) || '').slice(0, 2000);
  fail(`codeep review failed to run after ${attempts} attempts (npx exit: ${last && last.code}): ${detail}`);
  return { stdout: '', exitCode: 1 }; // unreachable (fail exits); satisfies callers
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
  const { stdout, exitCode } = await runCodeep(args);

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
