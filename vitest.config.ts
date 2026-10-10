import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: [
      {
        find: '@mizar/resource-pack-contract/runtime',
        replacement: fileURLToPath(
          new URL('./packages/resource-pack-contract/dist/runtime.js', import.meta.url),
        ),
      },
      {
        find: /^@mizar\/resource-pack-contract$/,
        replacement: fileURLToPath(
          new URL('./packages/resource-pack-contract/dist/index.js', import.meta.url),
        ),
      },
      {
        find: '../resource-store/runtime-adapter.js',
        replacement: fileURLToPath(
          new URL('./apps/companion/src/resource-store/runtime-adapter.ts', import.meta.url),
        ),
      },
    ],
  },
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
