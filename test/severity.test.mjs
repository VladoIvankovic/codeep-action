import { test } from 'node:test';
import assert from 'node:assert/strict';
import { severityIcon, severityLevel, validateFailOn, shouldFail } from '../scripts/lib.mjs';

test('severityIcon maps each severity, unknown falls back', () => {
  assert.equal(severityIcon('error'), '❌');
  assert.equal(severityIcon('warning'), '⚠️');
  assert.equal(severityIcon('info'), 'ℹ️');
  assert.equal(severityIcon('suggestion'), '💡');
  assert.equal(severityIcon('whatever'), '•');
});

test('severityLevel maps to GitHub annotation levels', () => {
  assert.equal(severityLevel('error'), 'error');
  assert.equal(severityLevel('warning'), 'warning');
  assert.equal(severityLevel('info'), 'notice');
  assert.equal(severityLevel('suggestion'), 'notice');
  assert.equal(severityLevel('mystery'), 'notice');
});

test('validateFailOn passes valid values, falls back to error otherwise', () => {
  for (const v of ['error', 'warning', 'info', 'none']) assert.equal(validateFailOn(v), v);
  assert.equal(validateFailOn('ERROR'), 'error'); // case-sensitive → fallback
  assert.equal(validateFailOn('bogus'), 'error');
  assert.equal(validateFailOn(''), 'error');
  assert.equal(validateFailOn(undefined), 'error');
});

const r = (severities) => ({ issues: severities.map((s) => ({ severity: s, file: 'a', category: 'x', message: 'm' })) });

test('shouldFail honors the threshold and mirrors the CLI ranking', () => {
  assert.equal(shouldFail(r(['error']), 'none'), false, 'none never fails');
  assert.equal(shouldFail(r(['warning']), 'error'), false, 'warnings do not trip --fail-on error');
  assert.equal(shouldFail(r(['error']), 'error'), true);
  assert.equal(shouldFail(r(['warning']), 'warning'), true);
  assert.equal(shouldFail(r(['info']), 'warning'), false);
  assert.equal(shouldFail(r(['info']), 'info'), true);
  assert.equal(shouldFail(r(['suggestion']), 'info'), false, 'suggestion ranks below info');
  assert.equal(shouldFail(r([]), 'error'), false, 'no issues never fails');
});
