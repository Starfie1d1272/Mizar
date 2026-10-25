import { installPerformanceJournal } from './debug/performance-journal';
import { installControlJournal } from './debug/control-journal';
import '@mizar/design-tokens/tokens.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';

import { MatchConnectionDialog } from './preparation/MatchConnectionDialog';
import { App } from './App';
import './product-shell.css';
import './styles.css';

const rootElement = document.getElementById('root');

if (!rootElement) {
  throw new Error('Web root element is missing');
}

installControlJournal();
installPerformanceJournal();

createRoot(rootElement).render(
  <StrictMode>
    <App />
    <MatchConnectionDialog />
  </StrictMode>,
);
