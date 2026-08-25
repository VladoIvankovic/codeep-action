// codeep-action entry point. Resolves the PR context, fetches the changed
// files, runs `codeep review <files> --json --fail-on <level>`, posts a sticky
// PR comment + inline annotations, and exits with the reviewer's code (so the
// PR check passes/fails per --fail-on). Zero deps — Node 24 built-ins only.

import { readFileSync, appendFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  MARKER, validateFailOn, parseEvent, filterChangedFiles, sanitizeFiles,
  buildAnnotations, formatComment, buildDashboardEvent,
  fixEligibility, explainFixSkip, fixBranchName, fixPullBody, hasProviderApiKey,
  describeFixOutcome, escapeData,
} from './lib.mjs';

const execFileP = promisify(execFile);
const API = 'https://api.github.com';
const CI_TOKEN_HEADER = 'x-codeep-ci-token';
const DASHBOARD_TIMEOUT_MS = 5000;

// Workflow commands are one line. An unescaped newline ends the command and
// the rest of the message is printed as ordinary log text, detached from the
// annotation — which is how a git push failure arrived as "Command failed: git
// push --force-with-lease origin codeep/fix/pr-2" with the actual reason,
// "(stale info)", stranded on the next line.
const cmd = (kind) => (m) => console.log(`::${kind}::${escapeData(m)}`);
const notice = cmd('notice');
const warn = cmd('warning');
const error = cmd('error');

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

// A fix run is a different animal on the same command. The review is regex over
// a diff and finishes in seconds; the fix runs an agent that reads files, edits
// them and runs the test suite. Holding it to the review's bound killed the
// first real fix at exactly 180s. Configurable because "long enough" depends on
// the project's test suite, not on anything this action can know.
const FIX_TIMEOUT_MS = Math.max(
  60_000,
  (Number(process.env.INPUT_FIX_TIMEOUT) || 600) * 1000,
);

/**
 * Run the CLI.
 *
 * `soft` is the difference between the two callers. A review that cannot run is
 * a failed check — there is no result to report. A *fix* that cannot run is a
 * fix that did not happen, and the action documents that a fix never changes
 * the check's outcome. Calling fail() there would turn a clean review red
 * because an optional extra step ran out of time.
 */
async function runCodeep(args, { attempts = 3, timeoutMs = REVIEW_TIMEOUT_MS, soft = false } = {}) {
  const giveUp = (message) => {
    if (soft) return { stdout: '', exitCode: 1, failed: message };
    fail(message);
    return { stdout: '', exitCode: 1 }; // unreachable (fail exits); satisfies callers
  };
  // The review child runs the CLI against PR-influenced config (custom
  // .codeep/review rules). It never needs the dashboard secret — that token is
  // only used by the analytics POST in THIS process — so strip it from the
  // child's environment rather than inheriting it wholesale.
  const childEnv = { ...process.env };
  delete childEnv.INPUT_DASHBOARD_TOKEN;
  let last;
  for (let i = 1; i <= attempts; i++) {
    try {
      const r = await execFileP('npx', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: timeoutMs, env: childEnv });
      return { stdout: r.stdout, exitCode: 0 };
    } catch (e) {
      if (e && e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
        return giveUp('codeep output exceeded the 32MB buffer; cannot parse the result. Scope the PR or raise the limit.');
      }
      // Timed out and killed (e.g. a catastrophic-backtracking custom rule, or a
      // very large PR). Do NOT retry — it would just time out again 3×.
      if (e && (e.killed === true || e.code === 'ETIMEDOUT')) {
        return giveUp(
          soft
            ? `The fix agent ran out of time after ${Math.round(timeoutMs / 1000)}s. Raise \`fix-timeout\` if the project's tests are slow, or narrow the review with \`fix-min-severity: error\`.`
            : `codeep review timed out after ${Math.round(timeoutMs / 1000)}s. A custom .codeep/review.json rule may be too slow (catastrophic backtracking), or the changed set is too large to review in one pass.`,
        );
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
  return giveUp(`codeep failed to run after ${attempts} attempts (npx exit: ${last && last.code}): ${detail}`);
}

// Fire-and-forget: POST a compact review summary (counts + worst-offender
// files; never source or messages) to the dashboard for team analytics. This is
// strictly additive telemetry — it MUST never change the review outcome, so
// every failure mode (unconfigured, fork PR, network, timeout, non-2xx) is
// swallowed with at most an informational notice. Hard-bounded to 5s.
async function postDashboardEvent(ctx, result, opts) {
  const { token, url, failOn, version } = opts;
  if (!token) return;          // not configured — also the case on fork PRs (secrets withheld)
  if (ctx.isFork) {            // don't attribute a fork's PR to the base repo's analytics
    notice('Dashboard analytics skipped for a fork PR.');
    return;
  }
  try {
    const payload = buildDashboardEvent(result, ctx, { failOn, version });
    const res = await fetch(`${url}/api/review-events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'codeep-action',
        [CI_TOKEN_HEADER]: token,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(DASHBOARD_TIMEOUT_MS),
    });
    if (!res.ok) notice(`Dashboard analytics POST returned ${res.status} (ignored).`);
  } catch (e) {
    notice(`Dashboard analytics POST skipped: ${(e && e.message) || e} (ignored).`);
  }
}

/**
 * Turn a failed GitHub response into something worth reading.
 *
 * One failure mode deserves naming outright. A repository has a setting —
 * Settings → Actions → General → Workflow permissions → "Allow GitHub Actions
 * to create and approve pull requests" — that is **off by default** and that a
 * workflow's own `permissions:` block cannot override. With it off, everything
 * up to and including the push succeeds and only the final POST is refused, so
 * the branch sits there with the fix on it and no pull request in sight.
 */
async function describeGhError(res) {
  const body = await res.text().catch(() => '');
  let message = body.slice(0, 300);
  try { message = JSON.parse(body).message || message; } catch { /* keep the raw text */ }

  if (/not permitted to create or approve pull requests/i.test(message)) {
    return `${res.status} — this repository does not allow GitHub Actions to open pull requests. `
      + 'Turn on Settings → Actions → General → Workflow permissions → '
      + '"Allow GitHub Actions to create and approve pull requests". A workflow\'s '
      + 'own permissions block cannot grant this one.';
  }
  return `${res.status} ${message}`;
}

/**
 * Commit whatever the fix run changed onto its own branch and open a pull
 * request against the one being reviewed.
 *
 * Never pushes to the reviewed branch. Pushing into someone else's pull request
 * takes a decision that is not ours to take — and on a fork it is not even
 * possible. A separate branch keeps the fix reviewable and refusable.
 *
 * Returns the pull request URL, or '' when nothing changed or the push failed.
 */
async function openFixPullRequest({ ctx, token, branch, summary, version }) {
  const git = async (...args) => {
    const { stdout } = await execFileP('git', args, { cwd: process.cwd(), maxBuffer: 8 * 1024 * 1024 });
    return stdout.trim();
  };

  try {
    // Nothing to propose is the common case and not a failure. Say which case
    // it was, though: "the agent declined" and "the agent edited a file and
    // git cannot see it" look identical from the outside and are not remotely
    // the same problem.
    // `.codeep/` is the agent's own bookkeeping — the audit record and its
    // progress log. Both are written during the run, and sweeping them into
    // someone's pull request puts a transcript of the prompt in their diff and
    // buries the two-line fix they actually have to read. Excluded from the
    // dirty check too, or a run that changed no code would still look dirty
    // and push an empty commit.
    const dirty = await git('status', '--porcelain', '--', '.', ':!.codeep');
    if (!dirty) {
      // "The agent declined" and "the agent edited a file and git cannot see
      // it" are indistinguishable from the outside and are not the same
      // problem at all, so say where git looked before concluding nothing
      // happened.
      const top = await git('rev-parse', '--show-toplevel').catch(() => '(not a repository)');
      notice(`codeep: the working tree is unchanged. git ran in ${process.cwd()}, repository root ${top}.`);
      return '';
    }
    notice(`codeep: ${dirty.split('\n').length} changed path(s) to propose.`);

    await git('config', 'user.name', 'codeep-action');
    await git('config', 'user.email', 'action@codeep.dev');
    await git('checkout', '-B', branch);
    await git('add', '-A', '--', '.', ':!.codeep');
    await git('commit', '-m', `fix: apply Codeep review findings from #${ctx.prNumber}`);

    // --force-with-lease needs a remote-tracking ref to compare against, and
    // actions/checkout fetches only the pull request's own ref — so for a fix
    // branch there is none and git refuses with "stale info" rather than
    // pushing. Fetching the branch first gives the lease something to hold; if
    // the branch does not exist upstream yet there is nothing to clobber and a
    // plain push is correct.
    let known = true;
    try {
      await git('fetch', '--depth', '1', 'origin', `${branch}:refs/remotes/origin/${branch}`);
    } catch {
      known = false;
    }
    await git('push', ...(known ? ['--force-with-lease'] : []), 'origin', branch);

    const res = await fetch(`${API}/repos/${ctx.owner}/${ctx.repo}/pulls`, {
      method: 'POST',
      headers: ghHeaders(token, true),
      body: JSON.stringify({
        title: `Codeep: fixes for #${ctx.prNumber}`,
        head: branch,
        base: ctx.headRef || ctx.baseRef,
        body: fixPullBody({ prNumber: ctx.prNumber, summary, version }),
        maintainer_can_modify: true,
      }),
    });

    if (res.status === 422) {
      // 422 usually means a pull request from this branch already exists —
      // successive runs on the same PR update the branch rather than opening a
      // second one. It is not the only 422 GitHub sends, though, so if no open
      // pull request turns up, report what it actually said.
      const open = await fetch(
        `${API}/repos/${ctx.owner}/${ctx.repo}/pulls?head=${ctx.owner}:${branch}&state=open`,
        { headers: ghHeaders(token) },
      );
      const list = open.ok ? await open.json() : [];
      const existing = (Array.isArray(list) && list[0] && list[0].html_url) || '';
      if (existing) return existing;
      warn(`codeep: the fix branch is pushed but GitHub declined to open a pull request: ${await describeGhError(res)}`);
      return '';
    }
    if (!res.ok) {
      // The branch is already pushed at this point, so silence here is the
      // worst possible outcome: the work exists and nothing says where. The
      // common cause is a repository setting rather than anything in the diff.
      warn(`codeep: the fix branch \`${branch}\` is pushed, but the pull request could not be opened: ${await describeGhError(res)}`);
      return '';
    }
    const created = await res.json();
    return created.html_url || '';
  } catch (e) {
    // A failed fix must never fail the review. The findings are already posted.
    notice(`codeep: could not open a fix pull request (${e && e.message ? e.message : e}).`);
    return '';
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
  const dashboardToken = (process.env.INPUT_DASHBOARD_TOKEN || '').trim();
  const dashboardUrl = (process.env.INPUT_DASHBOARD_URL || 'https://codeep.dev').trim().replace(/\/+$/, '');

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

  // Optional fix run. Deliberately after the comment and before the outputs:
  // the findings are already reported and the exit code already decided, so
  // nothing here can turn a red check green. A fix that hid the finding it
  // fixed would defeat the point of running a reviewer at all.
  const wantFix = process.env.INPUT_FIX === 'true';
  const fixable = (result.issues || []).filter(
    (i) => i.severity === 'error' || i.severity === 'warning',
  ).length;
  const eligibility = fixEligibility({
    enabled: wantFix,
    isFork: ctx.isFork === true,
    hasWriteToken: Boolean(token),
    hasApiKey: hasProviderApiKey(process.env),
    fixableCount: fixable,
  });

  let fixPrUrl = '';
  if (!eligibility.ok) {
    const why = explainFixSkip(eligibility.reason);
    if (why) notice(`codeep: ${why}`);
  } else {
    const branch = fixBranchName(ctx.prNumber, process.env.INPUT_FIX_BRANCH_PREFIX || 'codeep/fix');
    if (!branch) {
      notice('codeep: could not derive a branch name for the fix; skipping.');
    } else {
      const minSeverity = process.env.INPUT_FIX_MIN_SEVERITY === 'error' ? 'error' : 'warning';
      const fixRun = await runCodeep(
        ['--yes', `codeep@${version}`, 'review', '--fix',
          '--fix-min-severity', minSeverity, '--json', '--fail-on', 'none', '--', ...files],
        // soft: a fix that cannot finish is a fix that did not happen. The
        // review is already reported and its exit code is the gate.
        { timeoutMs: FIX_TIMEOUT_MS, soft: true },
      );
      let summary = '';
      try { summary = JSON.parse(fixRun.stdout).fix || ''; } catch { /* summary is optional */ }
      if (!fixRun.failed) {
        fixPrUrl = await openFixPullRequest({ ctx, token, branch, summary, version });
      }
      const outcome = describeFixOutcome({ prUrl: fixPrUrl, summary, failed: fixRun.failed });
      (outcome.level === 'warning' ? warn : notice)(outcome.text);
    }
  }
  setOutput('fix-pr', fixPrUrl);


  // Team analytics (opt-in via `dashboard-token`). Fire-and-forget — never
  // affects the check outcome.
  await postDashboardEvent(ctx, result, { token: dashboardToken, url: dashboardUrl, failOn, version });

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
