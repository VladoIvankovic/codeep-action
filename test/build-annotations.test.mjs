import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAnnotations, escapeData, escapeProp } from '../scripts/lib.mjs';

test('escapeData replaces % first, then CR/LF', () => {
  assert.equal(escapeData('a%b\nc\rd'), 'a%25b%0Ac%0Dd');
  assert.equal(escapeData('50%'), '50%25', 'percent must not be double-escaped');
});

test('escapeProp escapes data plus colon and comma', () => {
  assert.equal(escapeProp('a,b:c'), 'a%2Cb%3Ac');
  assert.equal(escapeProp('100%, x:y'), '100%25%2C x%3Ay');
});

test('buildAnnotations maps severities to levels and includes props', () => {
  const result = {
    issues: [
      { severity: 'error', file: 'src/a.ts', line: 42, category: 'security', message: 'bad' },
      { severity: 'warning', file: 'src/b.ts', line: 7, category: 'perf', message: 'slow' },
      { severity: 'info', file: 'src/c.ts', category: 'style', message: 'tidy' }, // no line
    ],
  };
  const out = buildAnnotations(result);
  assert.equal(out.length, 3);
  assert.match(out[0], /^::error file=src\/a\.ts,line=42,title=codeep%3A security::bad$/);
  assert.match(out[1], /^::warning /);
  assert.match(out[2], /^::notice file=src\/c\.ts,title=/);
  assert.equal(/line=/.test(out[2]), false, 'issue without a line omits line=');
});

test('buildAnnotations appends the suggestion and escapes the message', () => {
  const out = buildAnnotations({ issues: [
    { severity: 'error', file: 'f', line: 1, category: 'bug', message: 'a::b\nc', suggestion: 'fix it' },
  ] });
  assert.equal(out.length, 1);
  // message + suggestion, with :: and newline escaped so the line stays one command
  assert.ok(out[0].endsWith('::a%3A%3Ab%0Ac — fix it') === false); // colons in DATA are not escaped
  assert.ok(out[0].includes('a::b%0Ac — fix it'), `got: ${out[0]}`);
});

test('buildAnnotations caps at opts.max', () => {
  const issues = Array.from({ length: 50 }, (_, i) => ({ severity: 'info', file: 'f', line: i + 1, category: 'x', message: 'm' }));
  assert.equal(buildAnnotations({ issues }, { max: 10 }).length, 10);
});

test('buildAnnotations drops a non-numeric line instead of injecting it into the command', () => {
  // A malformed/injected line value must never reach the control line verbatim.
  const out = buildAnnotations({ issues: [
    { severity: 'error', file: 'f', line: '1,col=9::evil', category: 'bug', message: 'm' },
    { severity: 'error', file: 'g', line: -1, category: 'bug', message: 'm' },
  ] });
  assert.equal(/line=/.test(out[0]), false, 'non-numeric line omitted');
  assert.equal(out[0].includes('::evil'), false, 'no command injection via line');
  assert.equal(/line=/.test(out[1]), false, 'non-positive line omitted');
});
