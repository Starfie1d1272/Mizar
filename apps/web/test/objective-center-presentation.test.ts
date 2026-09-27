import { describe, expect, it } from 'vitest';
import type { ProgramPayload } from '@mizar/protocol/program';
import { getProgramFixture } from '../src/program/fixtures';
import { buildMatchHeaderPresentation } from '../src/program/widgets/match-header/presentation';
const base = getProgramFixture('real-live-rich')!.payload;
const build = (p: ProgramPayload) => buildMatchHeaderPresentation(p).objective;
const bomb = (state: 'planting' | 'planted' | 'defusing'): ProgramPayload => ({
  ...base,
  bomb: {
    state,
    sourcePlayerId: null,
    explosion: { remainingSeconds: 8, durationSeconds: 40 },
    action:
      state === 'planting'
        ? { kind: 'plant', sourcePlayerId: null, remainingSeconds: 1, durationSeconds: 3 }
        : {
            kind: 'defuse',
            sourcePlayerId: base.players[0]!.sourcePlayerId,
            remainingSeconds: 2,
            durationSeconds: 5,
            hasDefuseKit: true,
          },
  },
});
describe('objective center real-first state and edge matrix', () => {
  it('terminal bomb evidence prevents stale objective phase fallback', () => {
    const p = {
      ...base,
      bomb: { state: 'defused' as const, sourcePlayerId: null, explosion: null, action: null },
      clock: { phase: 'bomb' as const, endsInSeconds: 8 },
    };
    expect(buildMatchHeaderPresentation(p)).toMatchObject({
      phaseLabel: 'ROUND OVER',
      clockText: null,
      objective: { mode: 'normal' },
    });
  });
  it.each([
    ['real-planting', 'planting'],
    ['real-planted', 'planted'],
    ['real-defusing', 'defusing'],
    ['real-paused', 'paused'],
    ['real-timeout-ct', 'normal'],
    ['real-defused', 'normal'],
    ['real-exploded', 'normal'],
  ] as const)('%s resolves %s', (id, mode) =>
    expect(build(getProgramFixture(id)!.payload).mode).toBe(mode),
  );
  it('retains round clock while planting, dual tracks while defusing and danger', () => {
    expect(buildMatchHeaderPresentation(bomb('planting')).clockText).not.toBeNull();
    expect(build(bomb('defusing'))).toMatchObject({
      fuse: 0.2,
      action: 0.6,
      danger: true,
      hasKit: true,
      playerName: base.players[0]!.displayName,
    });
  });
  it('fails each track independently and respects unknown kit/name', () => {
    const p = bomb('defusing');
    expect(
      build({
        ...p,
        bomb: { ...p.bomb!, explosion: { remainingSeconds: 8, durationSeconds: null } },
      }),
    ).toMatchObject({ fuse: null, action: 0.6 });
    expect(
      build({
        ...p,
        bomb: {
          ...p.bomb!,
          action: {
            kind: 'defuse',
            sourcePlayerId: 'missing',
            remainingSeconds: 2,
            durationSeconds: null,
            hasDefuseKit: null,
          },
        },
      }),
    ).toMatchObject({ fuse: 0.2, action: null, playerName: null, hasKit: false });
    expect(
      build({
        ...p,
        bomb: { ...p.bomb!, explosion: { remainingSeconds: null, durationSeconds: 40 } },
      }).fuse,
    ).toBeNull();
  });
  it.each(['bomb', 'defuse'] as const)('phase %s fallback is state-only', (phase) =>
    expect(build({ ...base, bomb: null, clock: { phase, endsInSeconds: 8 } })).toMatchObject({
      stateOnly: true,
      fuse: null,
      action: null,
    }),
  );
  it.each(['paused'] as const)('%s overrides objective', (phase) =>
    expect(build({ ...bomb('planted'), clock: { phase, endsInSeconds: 10 } })).toMatchObject({
      mode: 'paused',
      aliveCount: null,
    }),
  );
  it.each(['timeout_ct', 'timeout_t'] as const)(
    '%s keeps objective state while timeout owns center',
    (phase) =>
      expect(build({ ...bomb('planted'), clock: { phase, endsInSeconds: 10 } })).toMatchObject({
        mode: 'planted',
        aliveCount: null,
      }),
  );
  it('requires complete 5+5 current evidence and entrant orientation', () => {
    expect(build(base).aliveCount).toBeNull();
    const dead = {
      ...base,
      players: base.players.map((p, i) => (i === 0 ? { ...p, lifeState: 'dead' as const } : p)),
    };
    expect(build(dead).aliveCount).toBe('4v5');
    const swapped = { ...dead, teams: { ct: dead.teams.t, t: dead.teams.ct } };
    expect(build(swapped).aliveCount).toBe('5v4');
    expect(
      build({
        ...dead,
        players: dead.players.map((p, i) =>
          i === 1 ? { ...p, lineupEvidence: 'retained' as const } : p,
        ),
      }).aliveCount,
    ).toBeNull();
    expect(build({ ...dead, players: dead.players.slice(1) }).aliveCount).toBeNull();
    expect(
      build({ ...dead, clock: { phase: 'freezetime', endsInSeconds: 10 } }).aliveCount,
    ).toBeNull();
  });
});
