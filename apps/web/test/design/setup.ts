import { beforeAll, afterEach } from 'vitest';
import { setProjectAnnotations } from '@storybook/react-vite';
import preview from '../../.storybook/preview.js';

const annotations = setProjectAnnotations([preview]);
beforeAll(annotations.beforeAll);
afterEach(() => {
  // Portable stories own their cleanup; this also resets browser focus between stories.
  document.body.replaceChildren();
});
