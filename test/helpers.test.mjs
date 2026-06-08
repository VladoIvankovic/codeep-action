import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEvent, filterChangedFiles, sanitizeFiles, capIssues, mdInlineCode, asLine } from '../scripts/lib.mjs';

const NUL = String.fromCharCode(0);

test('parseEvent reads PR context from the payload', () => {
  const ev = { pull_request: { number: 42, base: { sha: 'base1' }, head: { sha: 'head1' } } };
  assert.deepEqual(parseEvent(ev, 'pull_request', 'octo/repo'), {
    owner: 'octo', repo: 'repo', prNumber: 42, baseSha: 'base1', headSha: 'head1',
  });
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
