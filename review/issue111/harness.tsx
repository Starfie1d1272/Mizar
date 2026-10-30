import '@mizar/design-tokens/tokens.css';
import { createRoot } from 'react-dom/client';
import { StatsInsertView } from '@mizar/hud-view';
import { statsProgramInserts } from './src/program/stats-program';
const query = new URLSearchParams(location.search);
const projection = await fetch(`/__issue111_review-${query.get('fixture')}.json`).then(r => r.json());
const card = statsProgramInserts(projection).find(item => item.id === query.get('card'));
if (card) createRoot(document.getElementById('root')!).render(<StatsInsertView insert={query.get('fixture') === 'synthetic' || query.get('fixture')?.startsWith('phase-') ? card : {...card, scope:'本届 · 统计快照', phaseFormat: ''}} />);
