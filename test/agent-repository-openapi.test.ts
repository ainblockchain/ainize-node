import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildOpenApi } from '../src/openapi.js';

test('every repository history, review, mirror and preview API is discoverable in OpenAPI', () => {
 const spec = buildOpenApi('https://ainize.ai', 'test');
 const paths = spec.paths as Record<string, Record<string, { parameters?: {name: string; in: string; required?: boolean}[]; summary?: string }>>;
 for (const file of ['agent-git-routes.ts','agent-pull-routes.ts','agent-mirror-routes.ts','agent-preview-routes.ts']) {
  const source = readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
  for (const match of source.matchAll(/router\.(get|post|put|patch|delete)\('([^']+)'/g)) {
   const path = match[2]!.replace(/:(\w+)/g, '{$1}');
   const operation = paths[path]?.[match[1]!];
   assert.ok(operation?.summary, `${match[1]} ${path} is documented`);
   for (const param of path.matchAll(/\{(\w+)\}/g)) assert.ok(operation.parameters?.some(p => p.name === param[1] && p.in === 'path' && p.required), `${path}: ${param[1]} is required`);
  }
 }
 for (const path of ['/git/{id}.git/info/refs','/git/{id}.git/git-upload-pack','/git/{id}.git/git-receive-pack','/api/projects/{id}/source']) assert.ok(paths[path], path);
});
