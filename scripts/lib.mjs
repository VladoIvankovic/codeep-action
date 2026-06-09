// Pure helpers for codeep-action. No I/O, no process.exit, no fetch — every
// export here is deterministic and unit-tested (see ../test). review.mjs does
// the I/O and imports these.

export const MARKER = '<!-- codeep-review -->';

// Mirrors the CLI's SEVERITY_RANK (src/utils/headlessReview.ts): suggestion sits
// below info so `--fail-on info` never trips on a mere suggestion.
export const SEVERITY_RANK = { suggestion: 0, info: 1, warning: 2, error: 3 };

const FAIL_ON_VALUES = new Set(['error', 'warning', 'info', 'none']);

/** Severity → emoji for comment rendering. */
export function severityIcon(sev) {
  switch (sev) {
    case 'error': return '❌';
    case 'warning': return '⚠️';
    case 'info': return 'ℹ️';
    case 'suggestion': return '💡';
    default: return '•';
  }
}

/** Severity → GitHub log-annotation level. info/suggestion render as notice. */
export function severityLevel(sev) {
  switch (sev) {
    case 'error': return 'error';
    case 'warning': return 'warning';
    default: return 'notice';
  }
}

/** Validate the fail-on input; fall back to "error" for unset/invalid. */
export function validateFailOn(raw) {
  return FAIL_ON_VALUES.has(raw) ? raw : 'error';
}

/**
 * Parse the event payload into review context, or null when it isn't a PR.
 * `repoFull` is "owner/repo" (GITHUB_REPOSITORY).
 */
export function parseEvent(event, eventName, repoFull) {
  const pr = event && event.pull_request;
  if (!pr) return null;
  const number = pr.number ?? (event && event.number);
  if (!number) return null;
  const [owner, repo] = String(repoFull || '').split('/');
  if (!owner || !repo) return null;
  // A fork PR's head repo differs from the base repo (or is flagged `fork`).
  // GitHub withholds secrets from fork-PR workflows, so the dashboard token is
  // absent there anyway — but we also skip posting explicitly (defense + clarity).
  const headRepo = (pr.head && pr.head.repo) || null;
  const baseRepo = (pr.base && pr.base.repo) || null;
  const isFork = !!(
    (headRepo && headRepo.fork === true)
    || (headRepo && baseRepo && headRepo.full_name && baseRepo.full_name
        && headRepo.full_name !== baseRepo.full_name)
  );
  return {
    owner,
    repo,
    prNumber: Number(number),
    baseSha: (pr.base && pr.base.sha) || '',
    headSha: (pr.head && pr.head.sha) || '',
    author: (pr.user && typeof pr.user.login === 'string' && pr.user.login) || '',
    isFork,
  };
}

/**
 * Build the compact analytics payload POSTed to the dashboard (one row per PR
 * review run). Pure: counts + worst-offender files only — never source or
 * messages. `summary.byCategory` is already tallied by the CLI; we additionally
 * tally issues per file to surface review hotspots. `opts.version` is the
 * requested codeep version/dist-tag, `opts.failOn` the threshold used.
 */
export function buildDashboardEvent(result, ctx, opts = {}) {
  const r = result || {};
  const summary = r.summary || {};
  const bySev = summary.bySeverity || {};
  const fileCounts = new Map();
  for (const i of r.issues || []) {
    if (i && typeof i.file === 'string' && i.file) {
      fileCounts.set(i.file, (fileCounts.get(i.file) || 0) + 1);
    }
  }
  const topFiles = [...fileCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([file, count]) => ({ file, count }));
  return {
    repo: `${ctx.owner}/${ctx.repo}`,
    prNumber: ctx.prNumber,
    author: ctx.author || null,
    commitSha: ctx.headSha || null,
    score: typeof r.score === 'number' ? r.score : null,
    bySeverity: {
      error: bySev.error || 0,
      warning: bySev.warning || 0,
      info: bySev.info || 0,
    },
    byCategory: (summary.byCategory && typeof summary.byCategory === 'object') ? summary.byCategory : {},
    fileCount: Array.isArray(r.files) ? r.files.length : null,
    topFiles,
    failOn: opts.failOn || null,
    cliVersion: opts.version || null,
  };
}

/** From GitHub "list PR files" objects → head-tree filenames, dropping removals. */
export function filterChangedFiles(fileObjects) {
  const out = [];
  for (const f of fileObjects || []) {
    if (!f || f.status === 'removed') continue;
    if (typeof f.filename === 'string' && f.filename) out.push(f.filename);
  }
  return out;
}

/**
 * Security hardening of a candidate path list before it reaches the CLI:
 * drop NUL / absolute / `..`-traversal paths, `./`-prefix any leading-dash path
 * (option-injection guard), de-dup, preserve order.
 */
export function sanitizeFiles(paths) {
  const seen = new Set();
  const out = [];
  for (const raw of paths || []) {
    if (typeof raw !== 'string' || raw === '') continue;
    if (raw.includes('\u0000')) continue;                      // NUL byte
    if (raw.startsWith('/')) continue;                         // absolute
    if (raw.split('/').some((seg) => seg === '..')) continue;  // traversal
    let p = raw.startsWith('-') ? `./${raw}` : raw;            // option-injection
    if (seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}

/**
 * Whether a result trips a fail-on threshold. MIRRORS the CLI's
 * exitCodeForResult — used for assertions/tests only; the real gate is codeep's
 * process exit code, never this.
 */
export function shouldFail(result, failOn) {
  if (failOn === 'none') return false;
  const threshold = SEVERITY_RANK[failOn];
  if (threshold === undefined) return false;
  return (result && result.issues || []).some(
    (i) => (SEVERITY_RANK[i.severity] ?? 0) >= threshold,
  );
}

/** Escape text for a workflow-command message. `%` MUST be replaced first. */
export function escapeData(s) {
  return String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

/** Escape a workflow-command property value (data escapes + `:` and `,`). */
export function escapeProp(s) {
  return escapeData(s).replace(/:/g, '%3A').replace(/,/g, '%2C');
}

/**
 * Render arbitrary, possibly attacker-controlled text (e.g. a PR file path)
 * inside an inline markdown code span safely. Markdown is NOT parsed inside a
 * code span, so the only break-out vectors are a backtick (closes the span) and
 * a newline (ends the line) — neutralize both; everything else (brackets, angle
 * brackets, `<!-- -->`, pipes, links) then stays literal.
 */
export function mdInlineCode(s) {
  const safe = String(s).replace(/`/g, "'").replace(/[\r\n]+/g, ' ');
  return `\`${safe}\``;
}

/** Coerce a 1-based line number, or null when it isn't a usable positive int. */
export function asLine(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Build GitHub annotation command lines from a result, capped at opts.max.
 * Each line: `::<level> file=..,line=..,title=..::<message>`.
 */
export function buildAnnotations(result, opts = {}) {
  const max = opts.max ?? 50;
  const lines = [];
  for (const issue of (result && result.issues) || []) {
    if (lines.length >= max) break;
    const props = [`file=${escapeProp(issue.file)}`];
    const ln = asLine(issue.line);
    if (ln !== null) props.push(`line=${ln}`);
    if (issue.category) props.push(`title=${escapeProp(`codeep: ${issue.category}`)}`);
    let msg = issue.message || '';
    if (issue.suggestion) msg += ` — ${issue.suggestion}`;
    lines.push(`::${severityLevel(issue.severity)} ${props.join(',')}::${escapeData(msg)}`);
  }
  return lines;
}

/** Cap issues per file for rendering; report how many were omitted per file. */
export function capIssues(issuesByFile, maxPerFile) {
  const rendered = new Map();
  const omittedPerFile = new Map();
  for (const [file, issues] of issuesByFile) {
    if (issues.length > maxPerFile) {
      rendered.set(file, issues.slice(0, maxPerFile));
      omittedPerFile.set(file, issues.length - maxPerFile);
    } else {
      rendered.set(file, issues);
    }
  }
  return { rendered, omittedPerFile };
}

function scoreEmoji(score) {
  if (score >= 80) return '✅';
  if (score >= 60) return '⚠️';
  return '❌';
}

const SAFE_LIMIT = 60000; // stay well under GitHub's 65,536-char comment limit

/** Render the full sticky-comment markdown (leads with the hidden MARKER). */
export function formatComment(result, opts = {}) {
  const maxPerFile = opts.maxPerFile ?? 10;
  const failOn = opts.failOn ?? 'error';
  const version = opts.version ?? 'latest';
  const summary = (result && result.summary) || { totalIssues: 0, bySeverity: {} };
  const total = summary.totalIssues ?? ((result && result.issues && result.issues.length) || 0);
  const score = (result && result.score) ?? 0;
  const fileCount = (result && result.files && result.files.length) || 0;
  const fileWord = `${fileCount} changed file${fileCount === 1 ? '' : 's'}`;

  const footer = [
    '',
    '---',
    `Powered by [Codeep](https://www.npmjs.com/package/codeep) \`review\` · codeep@${version} · fail-on: \`${failOn}\``,
  ].join('\n');

  if (total === 0) {
    return [
      MARKER,
      '## Codeep Review — ✅ Clean',
      `> Reviewed ${fileWord}.`,
      '',
      'No issues found in the changed files. 🎉',
      footer,
    ].join('\n');
  }

  const bySev = summary.bySeverity || {};
  const head = [MARKER, `## Codeep Review — Score: ${score}/100 ${scoreEmoji(score)}`, `> Reviewed ${fileWord}.`, ''];
  head.push('| Severity | Count |', '|----------|-------|');
  for (const sev of ['error', 'warning', 'info', 'suggestion']) {
    const c = bySev[sev] ?? 0;
    if (c > 0) head.push(`| ${severityIcon(sev)} ${sev[0].toUpperCase()}${sev.slice(1)} | ${c} |`);
  }

  // Group issues by file, first-seen order.
  const byFile = new Map();
  for (const issue of (result && result.issues) || []) {
    if (!byFile.has(issue.file)) byFile.set(issue.file, []);
    byFile.get(issue.file).push(issue);
  }
  const { rendered, omittedPerFile } = capIssues(byFile, maxPerFile);

  let body = head.join('\n');
  let truncated = false;
  for (const [file, issues] of rendered) {
    // file is attacker-controlled on fork PRs — render it through mdInlineCode.
    const block = ['', `### ${mdInlineCode(file)}`];
    for (const i of issues) {
      const ln = asLine(i.line);
      const loc = ln !== null ? ` (L${ln})` : '';
      block.push(`- ${severityIcon(i.severity)} **${i.category}**${loc}: ${i.message}`);
      if (i.suggestion) block.push(`  - 💡 ${i.suggestion}`);
    }
    const omitted = omittedPerFile.get(file);
    if (omitted) block.push(`- …and ${omitted} more in this file`);
    const blockStr = block.join('\n');
    if (body.length + blockStr.length + footer.length > SAFE_LIMIT) {
      truncated = true;
      break;
    }
    body += `\n${blockStr}`;
  }
  if (truncated) body += `\n\n> …and more issues omitted; total ${total}.`;
  return body + footer;
}
