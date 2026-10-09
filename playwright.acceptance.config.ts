import { defineConfig } from '@playwright/test';

const acceptancePort = Number(process.env.PLAYWRIGHT_PORT ?? '4173');
const selectedFiles = process.env.MIZAR_BROWSER_FILES
  ? (JSON.parse(process.env.MIZAR_BROWSER_FILES) as string[])
  : undefined;

export default defineConfig({
  testDir: 'tests/acceptance',
  ...(selectedFiles ? { testMatch: selectedFiles.map((file) => `**/${file}`) } : {}),
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  failOnFlakyTests: true,
  retries: 0,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-acceptance-report' }]],
  projects: [
    {
      name: 'chromium',
      use: {
        baseURL: `http://127.0.0.1:${acceptancePort}`,
        browserName: 'chromium',
        deviceScaleFactor: 1,
        headless: true,
        viewport: { height: 1080, width: 1920 },
      },
    },
  ],
  webServer: {
    command: `pnpm --filter @mizar/web exec vite --host 127.0.0.1 --port ${acceptancePort}`,
    env: { VITE_VISUAL_FIXTURES: '1' },
    reuseExistingServer: !process.env.CI,
    url: `http://127.0.0.1:${acceptancePort}`,
  },
});
