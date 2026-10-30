import { expect, it } from 'vitest';
import { broadcastStatsSchema } from '../src/broadcast-stats.js';
import legacy from '../../../tests/fixtures/rivalhub-provider-stats-v1.json' with { type: 'json' };
import oneSided from '../../../tests/fixtures/rivalhub-provider-stats-v1-single-sided.json' with { type: 'json' };
import zero from '../../../tests/fixtures/rivalhub-provider-stats-v1-zero.json' with { type: 'json' };
import extended from '../../../tests/fixtures/rivalhub-provider-stats-v1-extended.json' with { type: 'json' };
import sparse from '../../../tests/fixtures/rivalhub-provider-stats-v1-sparse.json' with { type: 'json' };
import scoreboardOnly from '../../../tests/fixtures/rivalhub-provider-stats-v1-scoreboard-only.json' with { type: 'json' };

it('retains canonical optional facts and accepts the original v1 payload unchanged', () => {
  expect(broadcastStatsSchema.parse(legacy)).toEqual(legacy);
  expect(broadcastStatsSchema.parse(extended)).toEqual(extended);
  expect(broadcastStatsSchema.parse(oneSided)).toEqual(oneSided);
  expect(broadcastStatsSchema.parse(zero)).toEqual(zero);
  expect(broadcastStatsSchema.parse(sparse)).toEqual(sparse);
  expect(broadcastStatsSchema.parse(scoreboardOnly)).toEqual(scoreboardOnly);
});
