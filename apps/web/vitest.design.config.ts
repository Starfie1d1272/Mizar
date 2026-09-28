import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { playwright } from '@vitest/browser-playwright';

export default defineConfig({
  plugins: [react()],
  test: {
    include: ['test/design/**/*.browser.test.ts'],
    setupFiles: ['test/design/setup.ts'],
    browser: {
      enabled: true,
      provider: playwright({ contextOptions: { reducedMotion: 'reduce' } }),
      headless: true,
      instances: [{ browser: 'chromium' }],
    },
  },
});
