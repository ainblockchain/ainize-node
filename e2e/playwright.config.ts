import { defineConfig, devices } from '@playwright/test';

/**
 * Ainize UX scenario suite — runs against the LIVE demo cluster (node-a :3402 web+API, node-b :3403, node-c :3404,
 * local AIN chain). Scenarios are docs/ux-test-scenarios.json; each spec file tags its tests with the scenario id
 * (e.g. `test('AZ-017 …')`) so the results can be mapped back 1:1.
 *
 * Projects:
 *  - web      : browser scenarios (Chromium, desktop) — visitor / creator / cross-cutting pages
 *  - mobile   : the same pages at 360 px (only tests tagged @mobile)
 *  - cli-api  : Node/CLI/API/agent scenarios (no browser; run via request context + child processes)
 * Anything that touches the shared serving model (live test, apply/remove, verification) is tagged @runtime and
 * serialised with `test.describe.configure({ mode: 'serial' })` inside those files; workers=1 keeps it deterministic.
 */
export default defineConfig({
  testDir: './tests',
  // snapshot the live cluster before the run and verify it is unchanged afterwards (packages/e2e/global-state.ts)
  globalSetup: './global-state.ts',
  globalTeardown: './global-teardown.ts',
  timeout: 10 * 60_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 1,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'report' }], ['json', { outputFile: 'results/results.json' }]],
  use: {
    baseURL: process.env.AINIZE_URL ?? 'http://localhost:3402',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    actionTimeout: 30_000,
    navigationTimeout: 60_000,
    locale: 'en-US',
  },
  projects: [
    { name: 'web', testMatch: /web-.*\.spec\.ts/, use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 900 } } },
    { name: 'mobile', testMatch: /web-.*\.spec\.ts/, grep: /@mobile/, use: { ...devices['Pixel 5'], viewport: { width: 360, height: 780 } } },
    { name: 'cli-api', testMatch: /(cli|api|agent)-.*\.spec\.ts/ },
  ],
});
