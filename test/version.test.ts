import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { NODE_VERSION } from '../src/version.js';

test('node metadata uses the installed node package version', () => {
  assert.equal(NODE_VERSION, JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);
});
