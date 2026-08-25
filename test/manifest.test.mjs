import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const manifest = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'action.yml'),
  'utf8',
);

/**
 * Contexts an action manifest is allowed to name.
 *
 * `secrets` and `vars` are workflow-only. An action receives a secret by having
 * the *calling workflow* pass it in, as an input or an env var — it can never
 * reach into `secrets` itself.
 */
const ALLOWED = new Set(['github', 'inputs', 'runner', 'env', 'job', 'steps', 'strategy', 'matrix']);

/**
 * No `${{ }}` expression in action.yml may name a context actions do not have.
 *
 * GitHub evaluates expressions *everywhere* in the manifest, including inside
 * input `description:` prose. v1.0.3 shipped a description whose example read
 * `${{ secrets.CODEEP_DASHBOARD_TOKEN }}` — written as documentation, parsed as
 * code. The manifest failed validation and the action could not start at all,
 * for anyone, on any repository, from v1.0.3 until this test was written.
 *
 * Nothing caught it: the YAML is valid, the scripts are untouched, every unit
 * test passes, and the only symptom appears when a runner tries to load the
 * manifest. Documentation is the last place anyone looks for a syntax error.
 */
test('action.yml uses only contexts an action manifest may use', () => {
  const expressions = [...manifest.matchAll(/\$\{\{([^}]*)\}\}/g)].map(m => m[1].trim());
  assert.ok(expressions.length > 5, 'expected to find expressions; the regex may have rotted');

  const bad = expressions
    .map(expr => ({ expr, root: expr.match(/^([A-Za-z_][A-Za-z0-9_-]*)/)?.[1] }))
    .filter(({ root }) => root && !ALLOWED.has(root));

  assert.deepEqual(
    bad.map(b => b.expr),
    [],
    'these name a context an action cannot use — a workflow can, an action cannot',
  );
});

/**
 * The narrower statement of the same rule, kept separate so a failure says
 * "secrets" rather than making the reader work out which context was wrong.
 */
test('action.yml never mentions the secrets context, not even in prose', () => {
  assert.equal(
    /\$\{\{[^}]*\bsecrets\b/.test(manifest),
    false,
    'an example in a description is still an expression to the parser',
  );
});
