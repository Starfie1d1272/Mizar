import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { MatchContext } from '@mizar/core/match-context';
import { projectSeries, type ProgramProjection } from '@mizar/core/projection';
import { createSeriesProgress, syncSeriesProgress } from '@mizar/core/series-progress';
import type { ProgramSceneId } from '@mizar/protocol/program-scenes';
import { BpSession } from '../src/bp/controller.js';
import { OBS_COLLECTION, obsSceneName } from '../src/obs/desired-state.js';
import { switchObsScene, type ObsRpc } from '../src/obs/reconcile.js';
import { ObsVideoError } from '../src/obs/video-transaction.js';
import { ProgramSceneController } from '../src/program-scenes/controller.js';
import { DEFAULT_PROGRAM_TIMINGS, ProgramDirector } from '../src/program-scenes/director.js';
import {
  ProgramPresentationStore,
  completedMapResult,
  hasFrozenMapResult,
} from '../src/program-scenes/presentation.js';

function loadBaseFixtures() {
  const matchContext = JSON.parse(
    readFileSync(
      new URL('../../../packages/protocol/test/fixtures/match-document-v1.json', import.meta.url),
      'utf8',
    ),
  ) as MatchContext;
  const realFixtures = JSON.parse(
    readFileSync(
      new URL(
        '../../web/src/program/fixtures/generated/real-program-fixtures.generated.json',
        import.meta.url,
      ),
      'utf8',
    ),
  ) as {
    fixtures: Record<
      string,
      { snapshot: { cursor: ProgramProjection['cursor']; payload: ProgramProjection } }
    >;
  };
  const base = realFixtures.fixtures['real-gameover']!.snapshot;
  const context: MatchContext = {
    ...matchContext,
    format: 'bo3',
    status: 'in_progress',
    maps: ['de_inferno', 'de_anubis', 'de_mirage'].map((mapName, i) => ({
      mapId: `map-${i + 1}`,
      mapOrder: i + 1,
      mapName,
      pickedByEntryId:
        i % 2 === 0 ? matchContext.entrants.a.entryId : matchContext.entrants.b.entryId,
      teamAStartSide: 'CT',
      scoreA: null,
      scoreB: null,
      completedAt: null,
    })),
  };
  const baseProjection: ProgramProjection = {
    ...base.payload,
    cursor: base.cursor,
    status: { context: 'fresh', telemetry: 'fresh', identity: 'matched' },
    series: base.payload.series
      ? {
          ...base.payload.series,
          status: 'live',
          bindingState: 'bound',
          currentMapOrder: 1,
          maps: base.payload.series.maps.map((m, i) => ({
            ...m,
            status: i === 0 ? ('current' as const) : ('pending' as const),
            finalScore: null,
            winnerEntryId: null,
          })),
        }
      : null,
  };
  return { base, context, baseProjection };
}

function createDirectorRig(
  switchObs: (scene: ProgramSceneId) => Promise<void>,
  presentation?: ProgramPresentationStore,
) {
  const { base, context, baseProjection } = loadBaseFixtures();
  const state = {
    program: {
      ...baseProjection,
      map: { ...baseProjection.map, phase: 'warmup', roundNumber: 0 },
    } as ProgramProjection,
    telemetryFreshness: 'fresh' as 'fresh' | 'stale',
    now: 1000,
  };
  const coordinator = {
    getCurrent: () => ({
      program: state.program,
      operator: {
        runtime: { telemetryFreshness: state.telemetryFreshness },
        matchContext: { freshness: 'fresh', origin: 'rivalhub' },
        identity: { state: 'matched' },
      },
    }),
    getBpAssessment: () => ({ readiness: 'unavailable' as const }),
  };
  const bp = new BpSession(() => null);
  const controller = new ProgramSceneController(coordinator as never, bp, switchObs);
  const director = new ProgramDirector(
    coordinator as never,
    controller,
    bp,
    () => true,
    () => state.now,
    DEFAULT_PROGRAM_TIMINGS,
    () => presentation?.get(),
  );
  controller.attachDirector(director);
  return { base, context, baseProjection, state, controller, director };
}

describe('program director results, recovery, and OBS transition readback', () => {
  it('transitions gameplay -> map_result -> match_result after real series completion clears currentMapOrder', async () => {
    const presentationStore = new ProgramPresentationStore();
    const switched: ProgramSceneId[] = [];
    const rig = createDirectorRig(async (scene) => {
      switched.push(scene);
    }, presentationStore);
    const { base, context } = rig;
    const gen = base.cursor.programSourceGeneration;
    const step = (
      progress: ReturnType<typeof createSeriesProgress>,
      mapEpoch: number,
      mapName: string,
      roundNumber: number,
      score: { ct: number; t: number },
      mapEnded = false,
    ) =>
      syncSeriesProgress(progress, {
        observation: {
          sourceGeneration: gen,
          mapEpoch,
          mapName,
          roundNumber,
          score,
          roundWins: [],
          ...(mapEnded ? { mapEnded } : {}),
        },
        sideProof: { sourceGeneration: gen, mapEpoch, a: 'CT', b: 'T' },
        events: mapEnded
          ? [{ kind: 'map-ended', sourceGeneration: gen, mapEpoch, finalScore: score }]
          : [],
      }).progress;
    const makeProj = (
      series: NonNullable<ProgramProjection['series']>,
      mapName: string,
      phase: ProgramProjection['map']['phase'],
      mapEpoch: number,
      runtimeSeq: number,
      ct: number,
      t: number,
      telemetry: ProgramProjection['status']['telemetry'] = 'fresh',
    ): ProgramProjection => ({
      ...rig.baseProjection,
      cursor: { ...base.cursor, mapEpoch, runtimeSeq, programReceiveSequence: runtimeSeq },
      status: { context: 'fresh', telemetry, identity: 'matched' },
      match: { ...base.payload.match!, matchId: context.matchId, format: 'bo3' },
      series,
      map: { ...base.payload.map, name: mapName, phase, score: { ct, t } },
      teams: {
        ct: {
          mode: 'canonical',
          entryId: context.entrants.a.entryId,
          name: context.entrants.a.name,
          logoUrl: context.entrants.a.logoUrl,
          seriesScore: series.score.a ?? 0,
        },
        t: {
          mode: 'canonical',
          entryId: context.entrants.b.entryId,
          name: context.entrants.b.name,
          logoUrl: context.entrants.b.logoUrl,
          seriesScore: series.score.b ?? 0,
        },
      },
      players: base.payload.players.map((p, index) => ({
        ...p,
        side: index < 5 ? ('CT' as const) : ('T' as const),
        lineupEvidence: 'current' as const,
        sourcePlayerId: `76561198000000${index < 5 ? `0${index + 1}` : `1${index - 4}`}`,
      })),
    });

    let progress = createSeriesProgress(context);
    progress = step(progress, 1, 'de_inferno', 1, { ct: 0, t: 0 });
    progress = step(progress, 1, 'de_inferno', 24, { ct: 13, t: 11 }, true);
    progress = step(progress, 2, 'de_anubis', 19, { ct: 12, t: 7 });
    expect(progress.currentMapOrder).toBe(2);

    rig.state.program = makeProj(
      projectSeries(context, progress)!,
      'de_anubis',
      'live',
      2,
      100,
      12,
      7,
    );
    await rig.director.tick();
    expect(switched).toEqual(['gameplay']);

    progress = step(progress, 2, 'de_anubis', 20, { ct: 13, t: 7 }, true);
    expect(progress.currentMapOrder).toBeNull();
    const finalSeries = projectSeries(context, progress)!;
    expect(finalSeries.status).toBe('completed');
    rig.state.program = makeProj(finalSeries, 'de_anubis', 'gameover', 2, 101, 13, 7);
    presentationStore.update(rig.state.program, 'rev-1');

    const staleMap1 = makeProj(finalSeries, 'de_inferno', 'gameover', 1, 102, 13, 11, 'stale');
    expect(completedMapResult(staleMap1)).toBeUndefined();
    expect(hasFrozenMapResult(staleMap1, presentationStore.get())).toBe(false);

    rig.state.now = 2000;
    await rig.director.tick();
    expect(rig.director.get()).toMatchObject({ mode: 'auto', next: 'map_result' });

    rig.state.now = 5500;
    await rig.director.tick();
    expect(switched).toEqual(['gameplay', 'map_result']);

    rig.state.program = makeProj(finalSeries, 'de_anubis', 'gameover', 2, 103, 13, 7, 'stale');
    rig.state.telemetryFreshness = 'stale';
    for (let s = 1; s <= 14; s++) {
      rig.state.now = 5500 + s * 1000;
      await rig.director.tick();
    }
    expect(switched).toEqual(['gameplay', 'map_result', 'match_result']);
    expect(rig.director.get().nextStatus).toBe('complete');
  });

  it('recovers automatically from bounded transient OBS failures and respects manual hold', async () => {
    let obsReady = false;
    const switched: ProgramSceneId[] = [];
    const rig = createDirectorRig(async (scene) => {
      if (!obsReady) throw new Error('OBS 尚未连接');
      switched.push(scene);
    });
    rig.state.program = {
      ...rig.baseProjection,
      map: { ...rig.baseProjection.map, phase: 'live', roundNumber: 1 },
      round: { phase: 'live', winnerSide: 'unknown' },
    };
    await rig.director.tick();
    expect(rig.director.get().mode).toBe('blocked');
    expect(rig.director.get().reason).toContain('OBS 场景切换未完成');

    for (const ts of [1500, 3000, 7000, 14_000, 30_000]) {
      rig.state.now = ts;
      await rig.director.tick();
    }
    expect(switched).toEqual([]);

    obsReady = true;
    rig.state.now = 65_000;
    await rig.director.tick();
    expect(switched).toEqual(['gameplay']);
    expect(rig.director.get().mode).toBe('auto');

    rig.director.hold();
    rig.state.program = {
      ...rig.state.program,
      map: { ...rig.state.program.map, phase: 'warmup', roundNumber: 0 },
    };
    rig.state.now = 70_000;
    await rig.director.tick();
    expect(rig.director.get().mode).toBe('manual');
    expect(switched).toEqual(['gameplay']);
  });

  it('does not poll OBS on precondition or structural errors and recovers on interrupt', async () => {
    let sceneMissing = true;
    const attempts: ProgramSceneId[] = [];
    const switched: ProgramSceneId[] = [];
    const rig = createDirectorRig(async (scene) => {
      attempts.push(scene);
      if (sceneMissing && scene === 'gameplay')
        throw new ObsVideoError('scene_target_unavailable', '缺少目标 OBS 场景「比赛中」。');
      switched.push(scene);
    });
    rig.state.program = {
      ...rig.baseProjection,
      map: { ...rig.baseProjection.map, phase: 'live', roundNumber: 1 },
      round: { phase: 'live', winnerSide: 'unknown' },
    };
    rig.state.telemetryFreshness = 'stale';

    await rig.director.tick();
    rig.state.now = 10_000;
    await rig.director.tick();
    expect(attempts).toEqual([]);

    rig.state.telemetryFreshness = 'fresh';
    rig.state.now = 11_000;
    await rig.director.tick();
    const countBeforeWait = attempts.length;
    expect(attempts.filter((s) => s === 'gameplay')).toHaveLength(1);
    rig.state.now = 40_000;
    await rig.director.tick();
    expect(attempts.length).toBe(countBeforeWait);

    sceneMissing = false;
    rig.controller.obsProgramChanged();
    rig.state.now = 40_100;
    await rig.director.tick();
    expect(switched.at(-1)).toBe('gameplay');
    expect(rig.director.get().mode).toBe('auto');
  });

  it('confirms completed OBS fade transitions via readback when transition event is missed', async () => {
    const gameplayName = obsSceneName('gameplay');
    const waitingName = obsSceneName('waiting');
    let currentScene = waitingName;
    const obs: ObsRpc = {
      call: async (type, data) => {
        if (type === 'GetSceneCollectionList')
          return { currentSceneCollectionName: OBS_COLLECTION };
        if (type === 'GetSceneList')
          return {
            currentProgramSceneName: currentScene,
            scenes: [{ sceneName: waitingName }, { sceneName: gameplayName }],
          };
        if (type === 'GetInputList')
          return {
            inputs: [
              { inputName: '游戏画面', inputKind: 'game_capture' },
              { inputName: '比赛中画面', inputKind: 'browser_source' },
            ],
          };
        if (type === 'GetSceneItemList')
          return {
            sceneItems: [
              { sourceName: '游戏画面', sceneItemEnabled: true, sceneItemIndex: 0 },
              { sourceName: '比赛中画面', sceneItemEnabled: true, sceneItemIndex: 1 },
            ],
          };
        if (type === 'GetInputSettings')
          return data?.inputName === '游戏画面'
            ? {
                inputSettings: {
                  capture_mode: 'window',
                  window: 'Counter-Strike 2:SDL_app:cs2.exe',
                  priority: 2,
                },
              }
            : {
                inputSettings: { url: 'http://127.0.0.1:3000/program', width: 1920, height: 1080 },
              };
        if (type === 'GetInputPropertiesListPropertyItems') return { propertyItems: [] };
        if (type === 'GetSceneTransitionList')
          return { transitions: [{ transitionName: 'Fade', transitionKind: 'fade_transition' }] };
        if (type === 'SetCurrentProgramScene')
          currentScene = String(data?.sceneName ?? currentScene);
        if (type === 'GetCurrentProgramScene') return { currentProgramSceneName: currentScene };
        if (type === 'GetCurrentSceneTransitionCursor') return { transitionCursor: 1 };
        return {};
      },
      onTransitionVideoEnded: () => () => undefined,
    };
    await expect(
      switchObsScene(obs, 'gameplay', 'http://127.0.0.1:3000', {
        transition: { kind: 'fade', durationMs: 1 },
      }),
    ).resolves.toBeUndefined();
    expect(currentScene).toBe(gameplayName);
  });
});
