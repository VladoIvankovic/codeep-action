import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixEligibility, explainFixSkip, fixBranchName, fixPullBody, hasProviderApiKey } from '../scripts/lib.mjs';

const base = { enabled: true, isFork: false, hasWriteToken: true, hasApiKey: true, fixableCount: 3 };

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
  for (const reason of ['fork-pr', 'no-write-token', 'no-api-key', 'nothing-fixable']) {
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

// Reviewing is deterministic and offline — no key involved. `fix` runs an agent,
// so it is the first thing here that needs one, and the first place a user will
// be caught out. Without this gate the failure is silent: no agent, a clean
// working tree, no pull request, and nothing said about why.
test('does not attempt one without a provider API key', () => {
  assert.equal(fixEligibility({ ...base, hasApiKey: false }).reason, 'no-api-key');
  assert.match(explainFixSkip('no-api-key'), /API key/i);
});

// Write permission is checked first: it is the more specific problem, and a
// repository missing both should be told about the one it hits first anyway.
test('reports the missing token before the missing key', () => {
  assert.equal(
    fixEligibility({ ...base, hasWriteToken: false, hasApiKey: false }).reason,
    'no-write-token',
  );
});

test('recognises any provider key by shape, not by a list', () => {
  assert.equal(hasProviderApiKey({ ANTHROPIC_API_KEY: 'sk-x' }), true);
  assert.equal(hasProviderApiKey({ OPENROUTER_API_KEY: 'sk-x' }), true);
  // Not yet invented, and still recognised — the point of matching on shape.
  assert.equal(hasProviderApiKey({ SOMETHING_NEW_API_KEY: 'sk-x' }), true);

  assert.equal(hasProviderApiKey({}), false);
  assert.equal(hasProviderApiKey({ GITHUB_TOKEN: 'ghs_x' }), false);
  // An empty or whitespace value is how a secret that was never set arrives.
  assert.equal(hasProviderApiKey({ ANTHROPIC_API_KEY: '' }), false);
  assert.equal(hasProviderApiKey({ ANTHROPIC_API_KEY: '   ' }), false);
});
