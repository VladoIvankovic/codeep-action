import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatComment, MARKER } from '../scripts/lib.mjs';

function makeResult({ score = 90, issues = [], files = ['src/a.ts'] } = {}) {
  const bySeverity = { error: 0, warning: 0, info: 0, suggestion: 0 };
  for (const i of issues) bySeverity[i.severity] = (bySeverity[i.severity] || 0) + 1;
  return { files, issues, summary: { totalIssues: issues.length, byCategory: {}, bySeverity }, score, scope: `specific files (${files.length})` };
}

test('always starts with the hidden marker', () => {
  assert.ok(formatComment(makeResult()).startsWith(MARKER));
  assert.ok(formatComment(makeResult({ issues: [{ severity: 'error', file: 'a', line: 1, category: 'bug', message: 'm' }] })).startsWith(MARKER));
});

test('0 issues renders the Clean body', () => {
  const out = formatComment(makeResult({ score: 100 }));
  assert.match(out, /✅ Clean/);
  assert.match(out, /🎉/);
  assert.equal(/\| Severity \| Count \|/.test(out), false, 'no severity table when clean');
});

test('score badge crosses thresholds at 80 and 60', () => {
  const issue = { severity: 'warning', file: 'a', line: 1, category: 'x', message: 'm' };
  assert.match(formatComment(makeResult({ score: 80, issues: [issue] })), /Score: 80\/100 ✅/);
  assert.match(formatComment(makeResult({ score: 79, issues: [issue] })), /Score: 79\/100 ⚠️/);
  assert.match(formatComment(makeResult({ score: 60, issues: [issue] })), /Score: 60\/100 ⚠️/);
  assert.match(formatComment(makeResult({ score: 59, issues: [issue] })), /Score: 59\/100 ❌/);
});

test('severity table shows only non-zero rows reflecting counts', () => {
  const out = formatComment(makeResult({ issues: [
    { severity: 'error', file: 'a', line: 1, category: 'security', message: 'm' },
    { severity: 'error', file: 'a', line: 2, category: 'security', message: 'm' },
    { severity: 'info', file: 'a', line: 3, category: 'style', message: 'm' },
  ] }));
  assert.match(out, /\| ❌ Error \| 2 \|/);
  assert.match(out, /\| ℹ️ Info \| 1 \|/);
  assert.equal(/Warning/.test(out), false, 'zero-count rows are omitted');
});

test('groups issues by file and renders suggestions as indented bullets', () => {
  const out = formatComment(makeResult({ issues: [
    { severity: 'error', file: 'src/a.ts', line: 5, category: 'security', message: 'eval is bad', suggestion: 'use JSON.parse' },
    { severity: 'info', file: 'src/b.ts', line: 9, category: 'style', message: 'no console' },
  ] }));
  assert.match(out, /### `src\/a\.ts`/);
  assert.match(out, /- ❌ \*\*security\*\* \(L5\): eval is bad/);
  assert.match(out, /  - 💡 use JSON\.parse/);
  assert.match(out, /### `src\/b\.ts`/);
  assert.equal(/💡 use JSON\.parse[\s\S]*💡/.test(out), false, 'only one suggestion bullet');
});

test('caps issues per file with an overflow note', () => {
  const issues = Array.from({ length: 12 }, (_, i) => ({ severity: 'info', file: 'src/big.ts', line: i + 1, category: 'x', message: `m${i}` }));
  const out = formatComment(makeResult({ issues }), { maxPerFile: 10 });
  assert.match(out, /…and 2 more in this file/);
});

test('footer carries provenance', () => {
  const out = formatComment(makeResult({ issues: [{ severity: 'error', file: 'a', line: 1, category: 'x', message: 'm' }] }), { version: '2.5.0', failOn: 'warning' });
  assert.match(out, /Powered by \[Codeep\]/);
  assert.match(out, /codeep@2\.5\.0/);
  assert.match(out, /fail-on: `warning`/);
});

test('a malicious PR file path cannot break out of the comment code span', () => {
  const evilFile = 'a`b [click](https://evil.example)';
  const out = formatComment(makeResult({ files: [evilFile], issues: [
    { severity: 'error', file: evilFile, line: 1, category: 'security', message: 'm' },
  ] }));
  // The backtick that would close the code span is neutralized, so the link
  // text stays literal inside the span instead of rendering as a real link.
  assert.equal(out.includes('a`b'), false, 'raw backtick must not survive in the file header');
  assert.ok(out.includes("a'b [click](https://evil.example)"), 'path rendered literally inside one code span');
});

test('overall body stays under GitHub limit and notes omission', () => {
  // 500 files x 30 long issues each → far exceeds 60k chars.
  const issues = [];
  for (let f = 0; f < 500; f++) {
    for (let n = 0; n < 30; n++) {
      issues.push({ severity: 'info', file: `src/file${f}.ts`, line: n + 1, category: 'maintainability', message: 'x'.repeat(120) });
    }
  }
  const out = formatComment(makeResult({ issues, files: Array.from({ length: 500 }, (_, f) => `src/file${f}.ts`) }), { maxPerFile: 30 });
  assert.ok(out.length < 65536, `body length ${out.length} must stay under GitHub's limit`);
  assert.match(out, /…and more issues omitted; total \d+/);
});
