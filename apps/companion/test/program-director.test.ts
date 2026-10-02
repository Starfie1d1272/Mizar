import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { programSnapshotSchema } from '@mizar/protocol/program';
import type { ProjectionCoordinator } from '../src/projections/projection-coordinator.js';
import type { BpSession } from '../src/bp/controller.js';
import { ProgramSceneController } from '../src/program-scenes/controller.js';
import { ProgramDirector } from '../src/program-scenes/director.js';
import { ProgramPresentationStore } from '../src/program-scenes/presentation.js';

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
  const showFinal = vi.fn();
  const bp = {
    get: vi.fn(() => ({ projection: {}, state: 'shown', revision: 'bp' })),
    showFinal,
    setPaused: vi.fn(),
    command: vi.fn(() => ({})),
    finishSceneExit: vi.fn(),
  } as unknown as BpSession;
  const switchObs = vi.fn<() => Promise<void>>().mockResolvedValue();
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
    setProduction(value: boolean) {
      production = value;
    },
  };
}

describe('automatic Program choreography', () => {
  it('reveals warmup only once and does not replay it on map two', async () => {
    const r = rig();
    r.program.map.phase = 'warmup';
    r.program.clock!.phase = 'warmup';
    await r.step();
    expect(r.scenes.get().active).toBe('bp');
    await r.pass(2000);
    expect(r.scenes.get().active).toBe('waiting');
    await r.pass(20_000);
    expect(r.scenes.get().active).toBe('waiting');
    r.program.cursor.mapEpoch++;
    r.program.series!.currentMapOrder = 2;
    await r.step();
    expect(r.scenes.get().active).toBe('waiting');
    expect(r.showFinal).not.toHaveBeenCalled();
  });
  it('aborts an in-flight switch if the source generation changes', async () => {
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
    r.program.cursor.programSourceGeneration++;
    release();
    await automatic;
    await r.step();
    expect(r.scenes.get().active).toBe('waiting');
    expect(r.director.get().mode).toBe('blocked');
  });
  it('uses final BP, full intro, then HUD; manual take stays held until explicit resume', async () => {
    const r = rig();
    await r.step();
    expect(r.scenes.get().active).toBe('bp');
    expect(r.showFinal).toHaveBeenCalledOnce();
    await r.pass(10_000);
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
  it.each([
    [14, 'matchup', 2000],
    [10, 'gameplay', 6000],
    [8, 'gameplay', 6000],
  ] as const)('respects a %ss first-freeze deadline', async (seconds, scene, duration) => {
    const r = rig();
    r.program.clock!.endsInSeconds = seconds;
    await r.step();
    expect(r.scenes.get().active).toBe(scene);
    expect(r.director.get().introDurationMs).toBe(duration);
  });
  it('does not run in preparation, repeat a live intro, or progress on stale data', async () => {
    const r = rig();
    r.setProduction(false);
    await r.step();
    expect(r.scenes.get().active).toBe('waiting');
    r.setProduction(true);
    r.program.round!.phase = 'live';
    await r.step();
    expect(r.scenes.get().active).toBe('gameplay');
    r.program.round!.phase = 'freezetime';
    await r.step();
    expect(r.scenes.get().active).toBe('gameplay');
    r.program.status.telemetry = 'stale';
    await r.step();
    expect(r.director.get().mode).toBe('blocked');
  });
  it('holds long halftime and exits only at the second-half live deadline; OT is not halftime', async () => {
    const r = rig();
    r.program.map.score = { ct: 7, t: 5 };
    r.program.map.phase = 'intermission';
    await r.step();
    expect(r.scenes.get().active).toBe('halftime');
    r.program.map.phase = 'live';
    r.program.clock = { phase: 'paused', endsInSeconds: 160 };
    await r.pass(160_000);
    expect(r.scenes.get().active).toBe('halftime');
    r.program.clock = { phase: 'freezetime', endsInSeconds: 20 };
    r.program.map.roundNumber = 12;
    await r.step();
    expect(r.scenes.get().active).toBe('halftime');
    for (const seconds of [0, -1]) {
      r.program.clock.endsInSeconds = seconds;
      await r.step();
      expect(r.scenes.get().active).toBe('halftime');
    }
    r.program.clock.endsInSeconds = 5;
    await r.step();
    expect(r.scenes.get().active).toBe('gameplay');
    r.program.map.score = { ct: 12, t: 12 };
    r.program.map.phase = 'intermission';
    await r.step();
    expect(r.scenes.get().active).toBe('gameplay');
  });
  it('pauses intro time and aborts safely when OBS fails without retrying', async () => {
    const r = rig();
    r.program.clock!.endsInSeconds = 20;
    await r.step();
    expect(r.scenes.get().active).toBe('matchup');
    r.program.clock!.phase = 'paused';
    await r.pass(20_000);
    expect(r.scenes.get().active).toBe('matchup');
    r.program.clock!.phase = 'freezetime';
    r.program.clock!.endsInSeconds = 9;
    r.switchObs.mockRejectedValueOnce(new Error('offline'));
    await r.step();
    await r.pass(10_000);
    expect(r.scenes.get().active).toBe('matchup');
    expect(r.director.get().mode).toBe('blocked');
    // One failed Take plus one Cut restoring the last confirmed scene; no retry loop.
    expect(r.switchObs).toHaveBeenCalledTimes(3);
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
  it('resumes an already on-air manually selected result instead of getting stuck', async () => {
    const r = rig();
    await r.step();
    Object.assign(r.program, sample('real-gameover'));
    await r.scenes.select('map_result', r.scenes.get().revision);
    r.scenes.resumeAutomatic(r.scenes.get().revision);
    await r.step();
    await r.pass(12_000);
    expect(r.scenes.get().active).toBe('intermap');
  });
  it('shows a confirmed map result for 12s then the appropriate summary', async () => {
    const r = rig();
    Object.assign(r.program, sample('real-gameover'));
    await r.step();
    expect(r.scenes.get().active).toBe('map_result');
    await r.pass(11_900);
    expect(r.scenes.get().active).toBe('map_result');
    await r.step();
    expect(r.scenes.get().active).toBe(
      r.program.series!.status === 'completed' ? 'match_result' : 'intermap',
    );
  });
});

describe('bounded presentation snapshots', () => {
  it('keeps at most five maps and returns an isolated public projection', () => {
    const store = new ProgramPresentationStore();
    const p = sample('real-gameover');
    const base = p.series!.maps.find((map) => map.status === 'completed')!;
    for (let order = 1; order <= 8; order++) {
      p.series!.currentMapOrder = order;
      p.series!.maps = [{ ...base, mapOrder: order }];
      store.update(p, 'revision');
    }
    const first = store.get();
    expect(first.completed).toHaveLength(5);
    first.completed.splice(0);
    expect(store.get().completed).toHaveLength(5);
    store.update(p, 'different-context');
    expect(store.get().completed).toHaveLength(1);
  });
  it('captures map-end KAD once, retains through map reset/stale, and clears a different match', () => {
    const store = new ProgramPresentationStore();
    const p = sample('real-gameover');
    store.update(p, 'revision');
    const first = store.get();
    expect(first.completed).toHaveLength(1);
    p.players = [];
    p.map.phase = 'warmup';
    p.cursor.mapEpoch++;
    store.update(p, 'revision');
    expect(store.get().completed).toEqual(first.completed);
    p.status.context = 'stale';
    store.update(p, 'revision');
    expect(store.get().completed).toEqual(first.completed);
    p.match!.matchId = 'different';
    store.update(p, 'revision');
    expect(store.get().completed).toEqual([]);
  });
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
