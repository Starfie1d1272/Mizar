import { describe, expect, it } from 'vitest';

import {
  createCstvLiveSession,
  createCstvLiveSession as createSession,
  type CstvParserSessionFactoryOptions,
} from '../src/index.js';

const sync = {
  protocol: 5,
  tick: 100,
  ticksPerSecond: 64,
  fragment: 3,
  signupFragment: 2,
} as const;

function weaponFire() {
  return {
    userid: 9,
    player: { steamId: '76561198000000009', name: 'Shooter', teamNumber: 3 },
    weapon: 'm4a1',
    silenced: false,
  };
}

describe('CSTV live session', () => {
  it('creates a generation-scoped cursor through the parser-neutral seam', async () => {
    let parserOptions: CstvParserSessionFactoryOptions | undefined;
    const observations: unknown[] = [];
    const session = createCstvLiveSession({
      role: 'lookahead',
      generation: 4,
      url: 'https://example.test/cstv/',
      clock: { now: () => ({ observedAt: '2026-09-16T00:00:00.000Z', observedMonotonicMs: 12 }) },
      parserSessionFactory: (options) => {
        parserOptions = options;
        return {
          sync: null,
          tailTick: 0,
          start: () => {
            options.onSync(sync);
            options.onEvent('weapon_fire', weaponFire(), 101);
            return Promise.resolve({ status: 'ready' as const });
          },
          run: () => Promise.resolve({ status: 'complete' as const }),
          stop: () => {},
        };
      },
      onObservation: (observation) => observations.push(observation),
    });

    expect(await session.start()).toEqual({ status: 'ready' });
    expect(await session.run()).toEqual({ status: 'complete' });
    expect(parserOptions?.role).toBe('lookahead');
    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({
      kind: 'weapon-fire',
      cursor: {
        role: 'lookahead',
        generation: 4,
        sequence: 0,
        tick: 101,
        ticksPerSecond: 64,
      },
    });
  });

  it('reports normalization failures without breaking the parser session', async () => {
    const diagnostics: { code: string }[] = [];
    const session = createSession({
      role: 'program',
      generation: 0,
      url: 'https://example.test/cstv/',
      parserSessionFactory: (options) => ({
        sync: null,
        tailTick: 0,
        start: () => {
          for (let index = 0; index < 2; index += 1) {
            options.onEvent('weapon_fire', { userid: 1 }, index);
          }
          return Promise.resolve({ status: 'ready' as const });
        },
        run: () => Promise.resolve({ status: 'complete' as const }),
        stop: () => {},
      }),
      onObservation: () => {},
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });

    await session.start();
    expect(await session.run()).toEqual({ status: 'complete' });
    expect(diagnostics).toHaveLength(2);
    expect(diagnostics.every(({ code }) => code === 'normalization-failed')).toBe(true);
  });

  it('makes stop idempotent and does not expose third-party parser objects', () => {
    let stopCount = 0;
    const session = createCstvLiveSession({
      role: 'program',
      generation: 0,
      url: 'https://example.test/cstv/',
      parserSessionFactory: () => ({
        sync: null,
        tailTick: 0,
        start: () => Promise.resolve({ status: 'cancelled' as const }),
        run: () => Promise.resolve({ status: 'cancelled' as const }),
        stop: () => {
          stopCount += 1;
        },
      }),
      onObservation: () => {},
    });

    session.stop();
    session.stop();
    expect(stopCount).toBe(1);
    expect(session).not.toHaveProperty('parser');
  });
});
