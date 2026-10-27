import { expect, it } from 'vitest';
import type { ProgramProjection } from '@mizar/core/projection';
import { gameAudioTruth } from '../src/obs/audio-policy-truth.js';

it('does not treat a paused round 13 with a 12-round score as halftime', () => {
  const p = {
    status: { context: 'fresh', telemetry: 'fresh', identity: 'matched' },
    series: { bindingState: 'bound' },
    map: { score: { ct: 6, t: 6 }, phase: 'live', roundNumber: 13 },
    clock: { phase: 'paused', endsInSeconds: null },
  } as unknown as ProgramProjection;
  expect(gameAudioTruth(p, 'gameplay', true)).toBe('gameplay');
  const intermission = { ...p, map: { ...p.map, phase: 'intermission' as const, roundNumber: 12 } };
  expect(gameAudioTruth(intermission, 'halftime', true)).toBe('halftime');
  expect(gameAudioTruth(intermission, 'halftime', false)).toBe('unknown');
});
