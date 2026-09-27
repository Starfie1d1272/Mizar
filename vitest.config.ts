import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['apps/web/test/setup-react.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    include: [
      'apps/**/*.test.ts',
      'apps/**/*.test.tsx',
      'packages/**/*.test.ts',
      'scripts/**/*.test.mjs',
    ],
  },
});
