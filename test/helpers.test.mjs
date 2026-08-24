import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEvent, filterChangedFiles, sanitizeFiles, capIssues, mdInlineCode, asLine, buildDashboardEvent } from '../scripts/lib.mjs';

const NUL = String.fromCharCode(0);

test('parseEvent reads PR context from the payload', () => {
  const ev = {
    pull_request: {
      number: 42, user: { login: 'octocat' },
      base: { sha: 'base1', repo: { full_name: 'octo/repo' } },
      head: { sha: 'head1', repo: { full_name: 'octo/repo' } },
    },
  };
  assert.deepEqual(parseEvent(ev, 'pull_request', 'octo/repo'), {
    owner: 'octo', repo: 'repo', prNumber: 42, baseSha: 'base1', headSha: 'head1',
    author: 'octocat', isFork: false, headRef: '', baseRef: '',
  });
});

test('parseEvent flags fork PRs (head repo differs from base, or fork=true)', () => {
  const differing = {
    pull_request: {
      number: 7, base: { repo: { full_name: 'octo/repo' } },
      head: { repo: { full_name: 'attacker/repo' } },
    },
  };
  assert.equal(parseEvent(differing, 'pull_request', 'octo/repo').isFork, true);
  const flagged = { pull_request: { number: 8, head: { repo: { fork: true } } } };
  assert.equal(parseEvent(flagged, 'pull_request', 'octo/repo').isFork, true);
  // Missing repo metadata → not treated as a fork (same-repo PR with sparse payload).
  const sparse = { pull_request: { number: 9 } };
  assert.equal(parseEvent(sparse, 'pull_request', 'octo/repo').isFork, false);
});

test('buildDashboardEvent emits compact counts + per-file hotspots (no source)', () => {
  const result = {
    score: 72,
    files: ['src/a.ts', 'src/b.ts'],
    issues: [
      { file: 'src/a.ts', severity: 'error', category: 'security' },
      { file: 'src/a.ts', severity: 'warning', category: 'performance' },
      { file: 'src/b.ts', severity: 'info', category: 'security' },
    ],
    summary: {
      totalIssues: 3,
      byCategory: { security: 2, performance: 1 },
      bySeverity: { error: 1, warning: 1, info: 1, suggestion: 0 },
    },
  };
  const ctx = { owner: 'octo', repo: 'repo', prNumber: 42, author: 'octocat', headSha: 'deadbeef' };
  const ev = buildDashboardEvent(result, ctx, { failOn: 'error', version: '2.7.0' });
  assert.equal(ev.repo, 'octo/repo');
  assert.equal(ev.prNumber, 42);
  assert.equal(ev.author, 'octocat');
  assert.equal(ev.commitSha, 'deadbeef');
  assert.equal(ev.score, 72);
  assert.deepEqual(ev.bySeverity, { error: 1, warning: 1, info: 1 });
  assert.deepEqual(ev.byCategory, { security: 2, performance: 1 });
  assert.equal(ev.fileCount, 2);
  assert.deepEqual(ev.topFiles, [{ file: 'src/a.ts', count: 2 }, { file: 'src/b.ts', count: 1 }]);
  assert.equal(ev.failOn, 'error');
  assert.equal(ev.cliVersion, '2.7.0');
  // No source/message fields leak into the payload.
  assert.equal(JSON.stringify(ev).includes('message'), false);
});

test('buildDashboardEvent tolerates an empty/clean result', () => {
  const ev = buildDashboardEvent({ score: 100, files: [], issues: [], summary: {} },
    { owner: 'o', repo: 'r', prNumber: 1 }, {});
  assert.deepEqual(ev.bySeverity, { error: 0, warning: 0, info: 0 });
  assert.deepEqual(ev.byCategory, {});
  assert.deepEqual(ev.topFiles, []);
  assert.equal(ev.fileCount, 0);
  assert.equal(ev.author, null);
});

test('parseEvent returns null when not a PR or repo is malformed', () => {
  assert.equal(parseEvent({}, 'push', 'octo/repo'), null);
  assert.equal(parseEvent({ pull_request: { number: 1 } }, 'pull_request', 'norepo'), null);
  assert.equal(parseEvent({ pull_request: {} }, 'pull_request', 'octo/repo'), null, 'no number -> null');
});

test('filterChangedFiles drops removals and uses head filename', () => {
  const objs = [
    { status: 'added', filename: 'a.ts' },
    { status: 'modified', filename: 'b.ts' },
    { status: 'removed', filename: 'gone.ts' },
    { status: 'renamed', filename: 'new.ts', previous_filename: 'old.ts' },
    { status: 'copied', filename: 'c.ts' },
  ];
  assert.deepEqual(filterChangedFiles(objs), ['a.ts', 'b.ts', 'new.ts', 'c.ts']);
});

test('sanitizeFiles hardens against injection and traversal', () => {
  assert.deepEqual(sanitizeFiles(['-rf.js']), ['./-rf.js']);
  assert.deepEqual(sanitizeFiles(['--fail-on=none']), ['./--fail-on=none']);
  assert.deepEqual(sanitizeFiles(['/etc/passwd']), [], 'absolute dropped');
  assert.deepEqual(sanitizeFiles(['../../x']), [], 'traversal dropped');
  assert.deepEqual(sanitizeFiles(['a' + NUL + 'b']), [], 'NUL byte dropped');
  assert.deepEqual(sanitizeFiles(['x.ts', 'x.ts', 'y.ts']), ['x.ts', 'y.ts'], 'dedupe + order');
  assert.deepEqual(sanitizeFiles(['src/ok.ts']), ['src/ok.ts'], 'normal path untouched');
});

test('capIssues caps per file and reports the overflow', () => {
  const byFile = new Map([
    ['a', Array.from({ length: 12 }, (_, i) => ({ id: i }))],
    ['b', [{ id: 0 }, { id: 1 }]],
  ]);
  const { rendered, omittedPerFile } = capIssues(byFile, 10);
  assert.equal(rendered.get('a').length, 10);
  assert.equal(omittedPerFile.get('a'), 2);
  assert.equal(rendered.get('b').length, 2);
  assert.equal(omittedPerFile.has('b'), false);
});

test('mdInlineCode neutralizes code-span break-out (backtick, newline)', () => {
  assert.equal(mdInlineCode('src/ok.ts'), '`src/ok.ts`');
  // A leading backtick must NOT survive (it would close the span and let the
  // rest render as attacker markdown).
  assert.equal(mdInlineCode('x`</code>[click](https://evil)').includes('`</code>'), false);
  assert.equal(mdInlineCode('a`b'), "`a'b`");
  assert.equal(mdInlineCode('a\nb'), '`a b`');
  // The marker string stays literal text inside the span (no second real marker).
  assert.equal(/`<!-- codeep-review -->`/.test(mdInlineCode('<!-- codeep-review -->')), true);
});

test('asLine coerces only usable positive integers', () => {
  assert.equal(asLine(42), 42);
  assert.equal(asLine('7'), 7);
  assert.equal(asLine(0), null);
  assert.equal(asLine(-3), null);
  assert.equal(asLine(1.5), null);
  assert.equal(asLine('12-15'), null); // a range, not a line
  assert.equal(asLine('x'), null);
  assert.equal(asLine(undefined), null);
});

test('parseEvent carries the branch names a fix pull request needs', () => {
  const ctx = parseEvent({
    pull_request: {
      number: 12,
      head: { sha: 'aaa', ref: 'feature/login', repo: { full_name: 'me/repo' } },
      base: { sha: 'bbb', ref: 'main', repo: { full_name: 'me/repo' } },
      user: { login: 'me' },
    },
  }, 'pull_request', 'me/repo');

  assert.equal(ctx.headRef, 'feature/login');
  assert.equal(ctx.baseRef, 'main');
  assert.equal(ctx.isFork, false);
});

test('a malformed event yields empty branch names rather than undefined', () => {
  const ctx = parseEvent({
    pull_request: { number: 3, head: {}, base: {}, user: {} },
  }, 'pull_request', 'me/repo');
  assert.equal(ctx.headRef, '');
  assert.equal(ctx.baseRef, '');
});
