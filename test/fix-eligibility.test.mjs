import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixEligibility, explainFixSkip, fixBranchName, fixPullBody } from '../scripts/lib.mjs';

const base = { enabled: true, isFork: false, hasWriteToken: true, fixableCount: 3 };

test('a fix runs only when everything lines up', () => {
  assert.deepEqual(fixEligibility(base), { ok: true });
});

// A fork PR gets a read-only token. Trying anyway would fail the check and
// punish the contributor for how GitHub scopes tokens, not for their code.
test('never attempts a fix on a pull request from a fork', () => {
  assert.equal(fixEligibility({ ...base, isFork: true }).reason, 'fork-pr');
});

test('does not attempt one without write permissions', () => {
  assert.equal(fixEligibility({ ...base, hasWriteToken: false }).reason, 'no-write-token');
});

test('does not open an empty branch when nothing is fixable', () => {
  assert.equal(fixEligibility({ ...base, fixableCount: 0 }).reason, 'nothing-fixable');
});

test('says nothing at all when a fix was never requested', () => {
  assert.equal(fixEligibility({ ...base, enabled: false }).reason, 'not-requested');
  assert.equal(explainFixSkip('not-requested'), null);
});

test('every other refusal explains itself to the reader', () => {
  for (const reason of ['fork-pr', 'no-write-token', 'nothing-fixable']) {
    const text = explainFixSkip(reason);
    assert.ok(text && text.length > 20, `${reason} needs an explanation`);
  }
});

// The branch name reaches a git command, so anything shell-ish in the prefix
// has to be gone before it gets there.
test('branch names cannot carry anything but branch characters', () => {
  assert.equal(fixBranchName(42), 'codeep/fix/pr-42');
  assert.equal(fixBranchName(42, 'x; rm -rf /'), 'x--rm--rf/pr-42');
  assert.ok(!fixBranchName(42, '$(whoami)').includes('$'));
  assert.ok(!fixBranchName(42, 'a`b`c').includes('`'));
});

test('a nonsense PR number yields no branch rather than a strange one', () => {
  assert.equal(fixBranchName('not-a-number'), null);
  assert.equal(fixBranchName(0), null);
  assert.equal(fixBranchName(-5), null);
});

test('the pull request body says what did the work and what it could reach', () => {
  const body = fixPullBody({ prNumber: 7, summary: 'Attempting 2 errors.', version: '2.21.0' });
  assert.ok(body.includes('#7'));
  assert.ok(body.includes('Attempting 2 errors.'));
  assert.ok(body.includes('no shell, no network, no git'));
  assert.ok(body.includes('Nothing here has been merged.'));
});
