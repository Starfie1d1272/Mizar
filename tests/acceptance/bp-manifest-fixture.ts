import { getBpDemoManifest } from '../../packages/rivalhub/src/index.js';

export function bpManifestFixture(key: 'semifinalA' | 'final') {
  return getBpDemoManifest(key === 'semifinalA' ? 'bo3' : 'bo5');
}
