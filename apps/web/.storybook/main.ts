import type { StorybookConfig } from '@storybook/react-vite';

const config: StorybookConfig = {
  stories: ['../src/ui/**/*.stories.@(ts|tsx)', '../src/patterns/**/*.stories.@(ts|tsx)'],
  addons: ['@storybook/addon-a11y'],
  framework: {
    name: '@storybook/react-vite',
    options: { builder: { viteConfigPath: '.storybook/vite.config.ts' } },
  },
  core: { disableTelemetry: true },
  // Catalog uses no production replay API, CS2 assets or Companion.
  viteFinal: (config) => ({ ...config, publicDir: false }),
};
export default config;
