import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { at, requireSiblings, sourceLabel } from '../scripts/docs-gen/paths.mjs';

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

test('explicit sibling worktrees are validated and receive generated documentation', () => {
  const root = mkdtempSync(join(tmpdir(), 'ainize-doc-worktrees-'));
  const previous = process.env.AINIZE_DOCS_WEB_DIR;
  try {
    const web = join(root, 'web-review');
    mkdirSync(web);
    process.env.AINIZE_DOCS_WEB_DIR = web;
    assert.equal(at(join(root, 'node-review'), 'docs/en/reference/api.md'), join(web, 'docs/en/reference/api.md'));
    assert.doesNotThrow(() => requireSiblings(join(root, 'node-review'), ['web']));
    rmSync(web, { recursive: true });
    assert.throws(() => requireSiblings(join(root, 'node-review'), ['web']), /ainize-web/);
  } finally {
    if (previous === undefined) delete process.env.AINIZE_DOCS_WEB_DIR;
    else process.env.AINIZE_DOCS_WEB_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});


test('generated error source links are stable across explicit temporary checkouts', () => {
  const previous = process.env.AINIZE_DOCS_CORE_DIR;
  try {
    process.env.AINIZE_DOCS_CORE_DIR = '/tmp/release-core';
    assert.equal(sourceLabel('/tmp/release-node', '/tmp/release-core/src/catalog.ts'), '../ainize-core/src/catalog.ts');
    assert.equal(sourceLabel('/tmp/release-node', '/tmp/release-node/src/server.ts'), 'src/server.ts');
  } finally {
    if (previous === undefined) delete process.env.AINIZE_DOCS_CORE_DIR; else process.env.AINIZE_DOCS_CORE_DIR = previous;
  }
});
