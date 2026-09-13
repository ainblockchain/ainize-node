/**
 * The reference pages still describe this code.
 *
 * `docs/en/reference/` is generated from the declarations that define it: the yargs tree in the CLI, the OpenAPI
 * object here, the zod config schema in core, and the error literals across both. The point is not saving
 * typing — a hand-written command table is a second copy of the truth, and this product has shipped three of
 * them, two of which were wrong.
 *
 * WHY THIS TEST EXISTS SEPARATELY FROM THE GENERATOR. The generator stopped working when the monorepo was split
 * into separate repositories: every path in it was `packages/<name>/…`, which named nothing any more, so
 * `docs:check` was quietly dropped from the test script. Nobody noticed, and the pages drifted for weeks — the
 * CLI reference still described `ainize password [--reset]`, a command that had been deleted. A generator that is
 * not run is a generator that is not there, so running it is now a test.
 *
 * It needs the sibling repositories checked out beside this one, which is how this product is developed; where
 * they are absent it says so and stops rather than reporting a pass it did not earn.
 *
 *   node --test --import tsx test/docs-gen.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const SIBLINGS = ['ainize-core', 'ainize-cli', 'ainize-web'];
const missing = SIBLINGS.filter((n) => !existsSync(join(dirname(REPO), n)));

test('the generated reference pages match the code they are generated from', { skip: missing.length ? `needs ${missing.join(', ')} beside this repository` : false }, () => {
  const r = spawnSync(process.execPath, [join(REPO, 'scripts/docs-gen.mjs'), '--check'], { cwd: REPO, encoding: 'utf8' });
  // The generator prints one line per page and a diff for any that drifted, so its own output IS the message.
  assert.equal(r.status, 0, `\n${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /ok\s+docs\/en\/reference\/cli\.md/);
  assert.match(r.stdout, /ok\s+docs\/en\/reference\/errors\.md/);
});
