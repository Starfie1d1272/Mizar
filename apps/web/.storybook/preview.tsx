import type { Preview } from '@storybook/react-vite';
import '@fontsource/inter/400.css';
import '@fontsource/inter/600.css';
import '@mizar/design-tokens/tokens.css';
import '../src/ui/ui.css';

const preview: Preview = {
  decorators: [
    (Story, context) => (
      <main
        className="mizar-surface"
        data-surface={context.parameters.surface === 'technical' ? 'technical' : 'product'}
      >
        <Story />
      </main>
    ),
  ],
  parameters: {
    layout: 'padded',
    a11y: { test: 'error', config: { rules: [{ id: 'target-size', enabled: true }] } },
  },
};
export default preview;
