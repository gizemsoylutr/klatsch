// The UI layer: the flows of test/e2e/ in real browsers, Chromium and WebKit. Locally the installed Google
// Chrome is used for Chromium; WebKit needs `npx playwright install webkit` once. CI installs both
// (`npx playwright install --with-deps chromium webkit`).
// No retries: a flaky step is a finding, not something to retry away.
import { defineConfig } from '@playwright/test';

const ci = Boolean(process.env.CI);

export default defineConfig({
  testDir: 'test/ui',
  testMatch: '**/*.spec.ts',
  outputDir: 'test-results',
  globalSetup: './test/ui/global-setup.ts',
  globalTeardown: './test/ui/global-teardown.ts',
  workers: 1,
  fullyParallel: false,
  retries: 0,
  forbidOnly: ci,
  reporter: ci ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: { headless: true },
  // Chromium and WebKit (Safari's engine): layout bugs often show in only one of them.
  projects: [
    { name: 'chromium', use: { browserName: 'chromium', ...(ci ? {} : { channel: 'chrome' }) } },
    { name: 'webkit', use: { browserName: 'webkit' } },
  ],
});
