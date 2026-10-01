import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { at, requireSiblings } from '../scripts/docs-gen/paths.mjs';

test('documentation uses this checkout when its directory is not named ainize-node', () => {
  const root = mkdtempSync(join(tmpdir(), 'ainize-doc-paths-'));
  const repo = join(root, 'qa-job');
  try {
    for (const name of ['qa-job', 'ainize-core', 'ainize-cli', 'ainize-web']) {
      mkdirSync(join(root, name));
    }
    assert.equal(at(repo, 'packages/node/src/api.ts'), join(repo, 'src/api.ts'));
    assert.equal(at(repo, 'packages/node'), repo);
    assert.equal(at(repo, 'packages/core/src/config.ts'), join(root, 'ainize-core/src/config.ts'));
    assert.equal(at(repo, 'docs/en/reference/errors.md'), join(root, 'ainize-web/docs/en/reference/errors.md'));
    assert.doesNotThrow(() => requireSiblings(repo));
    rmSync(join(root, 'ainize-cli'), { recursive: true });
    assert.throws(() => requireSiblings(repo), /ainize-cli/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
