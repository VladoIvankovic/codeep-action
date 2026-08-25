import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const lib = readFileSync(join(root, 'scripts', 'lib.mjs'), 'utf8');
const review = readFileSync(join(root, 'scripts', 'review.mjs'), 'utf8');

/**
 * Every helper `review.mjs` calls must actually be imported.
 *
 * This is not a hypothetical. `fix` shipped with `fixEligibility`,
 * `explainFixSkip`, `fixBranchName` and `fixPullBody` written, exported, unit
 * tested — and absent from the import list. Node does not object: a free
 * identifier in an ES module is resolved when the line runs, not when the
 * module loads. Every test passed, the module imported cleanly, and the first
 * real run with `fix: true` would have died on `ReferenceError`.
 *
 * The unit tests could not catch it because they import from `lib.mjs`
 * themselves. Only the seam between the two files was wrong, so only something
 * that reads both files can see it.
 */
test('every lib helper review.mjs calls is imported', () => {
  const exported = [...lib.matchAll(/export (?:function|const|let)\s+([A-Za-z0-9_]+)/g)]
    .map(m => m[1]);
  assert.ok(exported.length > 10, 'expected to find lib exports; the regex may have rotted');

  const block = review.match(/import \{([^}]*)\} from '\.\/lib\.mjs'/s)?.[1];
  assert.ok(block, 'review.mjs should import from lib.mjs');
  const imported = new Set(block.split(/[,\s]+/).filter(Boolean));

  const missing = exported
    .filter(name => new RegExp(`\\b${name}\\s*\\(`).test(review))
    .filter(name => !imported.has(name));

  assert.deepEqual(missing, [], `called but never imported: ${missing.join(', ')}`);
});

/**
 * The reverse: an import nothing calls is dead weight and usually the residue
 * of a half-finished change. Cheap to check while both files are already read.
 */
test('review.mjs imports nothing it does not use', () => {
  const block = review.match(/import \{([^}]*)\} from '\.\/lib\.mjs'/s)?.[1] ?? '';
  const imported = block.split(/[,\s]+/).filter(Boolean);
  const body = review.slice(review.indexOf("from './lib.mjs'"));

  const unused = imported.filter(name => !new RegExp(`\\b${name}\\b`).test(body));
  assert.deepEqual(unused, [], `imported but never used: ${unused.join(', ')}`);
});
