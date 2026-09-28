import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['apps/web/test/setup-react.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', 'apps/web/test/design/**'],
    include: [
      'apps/**/*.test.ts',
      'apps/**/*.test.tsx',
      'packages/**/*.test.ts',
      'packages/**/*.test.mjs',
      'scripts/**/*.test.mjs',
    ],
  },
});
