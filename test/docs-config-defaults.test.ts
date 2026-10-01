import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { renderConfigPage } from '../scripts/docs-gen/config-page.mjs';

test('generated config examples do not depend on the runtime directory on the build host', async () => {
  const repo = dirname(dirname(fileURLToPath(import.meta.url)));
  const core = join(dirname(repo), 'ainize-core/src');
  const schema = await import(pathToFileURL(join(core, 'config-schema.ts')).href);
  const config = await import(pathToFileURL(join(core, 'config.ts')).href);
  const render = (hasRuntime: boolean) => renderConfigPage(repo, {
    schema,
    config: {
      ...config,
      defaultConfig: (options: unknown) => {
        const value = config.defaultConfig(options);
        if (hasRuntime) value.runtime.repo = '/mnt/newdata/qwen3.8';
        else delete value.runtime.repo;
        return value;
      },
    },
  });
  assert.deepEqual(render(true), render(false));
});
