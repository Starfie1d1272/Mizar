import eslint from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

const typeCheckedConfigs = tseslint.configs.recommended.map((config) => ({
  ...config,
  files: ['**/*.{ts,tsx,mts,cts}'],
}));

export default tseslint.config(
  {
    ignores: ['**/.agent-tmp/**', '**/.tmp/**', '**/dist/**', '**/node_modules/**'],
  },
  eslint.configs.recommended,
  ...typeCheckedConfigs,
  {
    files: [
      'apps/web/**/*.{ts,tsx}',
      'packages/radar-view/src/**/*.{ts,tsx}',
      'packages/hud-view/src/**/*.{ts,tsx}',
      'packages/radar-view/examples/**/*.{ts,tsx}',
    ],
    plugins: {
      'react-hooks': reactHooks,
    },
    rules: {
      ...reactHooks.configs['recommended-latest'].rules,
    },
  },
  {
    files: ['scripts/**/*.mjs', 'packages/design-tokens/scripts/**/*.mjs'],
    languageOptions: {
      globals: {
        console: 'readonly',
        process: 'readonly',
      },
    },
  },
);
