import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { programSnapshotSchema } from '@mizar/protocol/program';
import type { ProjectionCoordinator } from '../src/projections/projection-coordinator.js';
import type { BpSession } from '../src/bp/controller.js';
import { ProgramSceneController } from '../src/program-scenes/controller.js';
import { ProgramDirector } from '../src/program-scenes/director.js';
import { ProgramPresentationStore } from '../src/program-scenes/presentation.js';
import type { ObsSceneSwitchOptions } from '../src/obs/reconcile.js';
import type { ProgramSceneId } from '@mizar/protocol/program-scenes';

function sample(id = 'real-live-rich') {
  const artifact = JSON.parse(
    readFileSync(
      new URL(
        '../../web/src/program/fixtures/generated/real-program-fixtures.generated.json',
        import.meta.url,
      ),
      'utf8',
    ),
  ) as { fixtures: Record<string, { snapshot: unknown }> };
  const snapshot = programSnapshotSchema.parse(artifact.fixtures[id]?.snapshot);
  const p = { ...snapshot.payload, cursor: snapshot.cursor };
  p.status = { context: 'fresh', telemetry: 'fresh', identity: 'matched' };
  p.series!.bindingState = 'bound';
  return p;
}
function rig() {
  const program = sample();
  program.map.phase = 'live';
  program.map.roundNumber = 0;
  program.round = { phase: 'freezetime', winnerSide: 'unknown' };
  program.clock = { phase: 'freezetime', endsInSeconds: 40 };
  const operator = {
    runtime: { telemetryFreshness: 'fresh' },
    matchContext: { freshness: 'fresh', origin: 'local' },
    identity: { state: 'matched' },
  };
  const projection = {
    getCurrent: () => ({ program, operator }),
    getBpAssessment: () => ({ readiness: 'ready' }),
  } as unknown as ProjectionCoordinator;
  let bpState = 'shown';
  const showFinal = vi.fn(() => {
    bpState = 'shown';
  });
  const bp = {
    get: vi.fn(() => ({ projection: {}, state: bpState, revision: 'bp' })),
    showFinal,
    setPaused: vi.fn(),
    command: vi.fn(() => ({})),
    finishSceneExit: vi.fn(),
  } as unknown as BpSession;
  const switchObs = vi
    .fn<(id: ProgramSceneId, options?: ObsSceneSwitchOptions) => Promise<void>>()
    .mockResolvedValue();
  const scenes = new ProgramSceneController(projection, bp, switchObs);
  let time = 0;
  let production = true;
  const director = new ProgramDirector(
    projection,
    scenes,
    bp,
    () => production,
    () => time,
  );
  scenes.attachDirector(director);
  return {
    program,
    operator,
    bp,
    scenes,
    director,
    switchObs,
    showFinal,
    async step(ms = 100) {
      time += ms;
      await director.tick();
    },
    async pass(ms: number) {
      for (let n = 0; n < ms; n += 100) {
        time += 100;
        await director.tick();
      }
    },
    setBpState(value: 'shown' | 'revealing') {
      bpState = value;
    },
    setProduction(value: boolean) {
      production = value;
    },
  };
}

describe('automatic Program choreography', () => {
  it('re-evaluates a cancelled Take even when facts change again before its rejection', async () => {
    const r = rig();
    let release!: () => void;
    r.switchObs.mockImplementationOnce(async (_id, options) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      if (options?.signal?.aborted) throw new Error('cancelled obsolete transition');
    });
    const pending = r.step();
    await Promise.resolve();
    await Promise.resolve();
    r.program.round = { phase: 'live', winnerSide: 'unknown' };
    r.program.clock = { phase: 'live', endsInSeconds: 80 };
    await r.step();
    r.program.map.phase = 'gameover';
    r.program.clock = { phase: 'freezetime', endsInSeconds: -1 };
    release();
    await pending;
    r.program.map.phase = 'live';
    r.program.round = { phase: 'live', winnerSide: 'unknown' };
    r.program.clock = { phase: 'live', endsInSeconds: 70 };
    await r.step();
    expect(r.director.get().mode).toBe('auto');
    expect(r.scenes.get().active).toBe('gameplay');
  });
  it('uses final BP, full intro, then HUD; manual take stays held until explicit resume', async () => {
    const r = rig();
    await r.step();
    expect(r.scenes.get().active).toBe('bp');
    expect(r.showFinal).toHaveBeenCalledOnce();
    await r.pass(12_000);
    expect(r.scenes.get().active).toBe('matchup');
    await r.pass(6000);
    expect(r.scenes.get().active).toBe('gameplay');
    await r.scenes.select('waiting', r.scenes.get().revision);
    await r.pass(60_000);
    expect(r.scenes.get().active).toBe('waiting');
    expect(r.director.get().mode).toBe('manual');
    r.scenes.resumeAutomatic(r.scenes.get().revision);
    await r.step();
    expect(r.scenes.get().active).toBe('gameplay');
  });
  it('invalidates an in-flight automatic take when the operator takes control', async () => {
    const r = rig();
    let release!: () => void;
    r.switchObs.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const automatic = r.step();
    await Promise.resolve();
    await Promise.resolve();
    const manual = r.scenes.select('waiting', r.scenes.get().revision);
    release();
    await automatic;
    await manual;
    expect(r.scenes.get().active).toBe('waiting');
    expect(r.director.get().mode).toBe('manual');
  });
});

describe('bounded presentation snapshots', () => {
  it('does not guess player data or save finals on stale telemetry / wrong identity', () => {
    const store = new ProgramPresentationStore();
    const p = sample('real-gameover');
    p.status.telemetry = 'stale';
    store.update(p, 'revision');
    expect(store.get().completed).toHaveLength(0);
    p.status.telemetry = 'fresh';
    p.status.identity = 'mismatch';
    store.update(p, 'revision');
    expect(store.get().completed).toHaveLength(0);
    p.status.identity = 'matched';
    p.players = [];
    store.update(p, 'revision');
    expect(store.get().completed[0]?.players).toEqual({ a: [], b: [] });
  });
});
