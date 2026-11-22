import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ProgramProjection } from '@mizar/core/projection';
import type { ProgramSceneId } from '@mizar/protocol/program-scenes';
import { BpSession } from '../src/bp/controller.js';
import { OBS_COLLECTION, obsSceneName } from '../src/obs/desired-state.js';
import { switchObsScene, type ObsRpc } from '../src/obs/reconcile.js';
import { ObsVideoError } from '../src/obs/video-transaction.js';
import { ProgramSceneController } from '../src/program-scenes/controller.js';
import { DEFAULT_PROGRAM_TIMINGS, ProgramDirector } from '../src/program-scenes/director.js';

function loadBaseProjection(): ProgramProjection {
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
  const snap = realFixtures.fixtures['real-gameover']!.snapshot;
  return {
    ...snap.payload,
    cursor: snap.cursor,
    status: { context: 'fresh', telemetry: 'fresh', identity: 'matched' },
    series: snap.payload.series
      ? {
          ...snap.payload.series,
          status: 'live',
          bindingState: 'bound',
          currentMapOrder: 1,
          maps: snap.payload.series.maps.map((m, index) => ({
            ...m,
            status: index === 0 ? ('current' as const) : ('pending' as const),
            finalScore: null,
            winnerEntryId: null,
          })),
        }
      : null,
  };
}

describe('director transient failure recovery and OBS transition readback', () => {
  it('recovers automatically from transient OBS switch failure using current match facts, while respecting manual hold', async () => {
    const base = loadBaseProjection();
    let currentProgram: ProgramProjection = {
      ...base,
      map: { ...base.map, phase: 'warmup', roundNumber: 0 },
    };
    const coordinator = {
      getCurrent: () => ({
        program: currentProgram,
        operator: {
          runtime: { telemetryFreshness: 'fresh' },
          matchContext: { freshness: 'fresh', origin: 'rivalhub' },
          identity: { state: 'matched' },
        },
      }),
      getBpAssessment: () => ({ readiness: 'unavailable' as const }),
    };

    let obsReady = false;
    const switched: ProgramSceneId[] = [];
    const bp = new BpSession(() => null);
    const controller = new ProgramSceneController(coordinator as never, bp, async (scene) => {
      if (!obsReady) throw new Error('OBS 尚未连接');
      switched.push(scene);
    });
    let now = 1000;
    const director = new ProgramDirector(
      coordinator as never,
      controller,
      bp,
      () => true,
      () => now,
      DEFAULT_PROGRAM_TIMINGS,
    );
    controller.attachDirector(director);

    // Move to live round 1 while OBS is briefly unavailable.
    currentProgram = {
      ...base,
      map: { ...base.map, phase: 'live', roundNumber: 1 },
      round: { phase: 'live', winnerSide: 'unknown' },
    };
    await director.tick();
    expect(director.get().mode).toBe('blocked');
    expect(director.get().reason).toContain('OBS 场景切换未完成');
    expect(switched).toEqual([]);

    // Inside cooldown window: stays blocked without hammering OBS.
    now = 1500;
    await director.tick();
    expect(director.get().mode).toBe('blocked');
    expect(switched).toEqual([]);

    // OBS becomes ready after cooldown: director recovers to auto and switches to current target.
    obsReady = true;
    now = 3000;
    await director.tick();
    expect(switched).toEqual(['gameplay']);
    expect(director.get().mode).toBe('auto');
    expect(director.get().reason).toBeNull();

    // Operator manual hold is never overridden by automatic ticks.
    director.hold();
    currentProgram = {
      ...currentProgram,
      map: { ...currentProgram.map, phase: 'warmup', roundNumber: 0 },
    };
    now = 6000;
    await director.tick();
    expect(director.get().mode).toBe('manual');
    expect(switched).toEqual(['gameplay']);
  });

  it('confirms completed OBS fade transitions via readback when SceneTransitionVideoEnded is late or missed', async () => {
    const gameplayName = obsSceneName('gameplay');
    const waitingName = obsSceneName('waiting');
    let currentScene = waitingName;
    const obs: ObsRpc = {
      call: async (requestType, requestData) => {
        if (requestType === 'GetSceneCollectionList')
          return { currentSceneCollectionName: OBS_COLLECTION };
        if (requestType === 'GetSceneList') {
          return {
            currentProgramSceneName: currentScene,
            scenes: [{ sceneName: waitingName }, { sceneName: gameplayName }],
          };
        }
        if (requestType === 'GetInputList') {
          return {
            inputs: [
              { inputName: '游戏画面', inputKind: 'game_capture' },
              { inputName: '比赛中画面', inputKind: 'browser_source' },
            ],
          };
        }
        if (requestType === 'GetSceneItemList') {
          return {
            sceneItems: [
              { sourceName: '游戏画面', sceneItemEnabled: true, sceneItemIndex: 0 },
              { sourceName: '比赛中画面', sceneItemEnabled: true, sceneItemIndex: 1 },
            ],
          };
        }
        if (requestType === 'GetInputSettings') {
          if (requestData?.inputName === '游戏画面') {
            return {
              inputSettings: {
                capture_mode: 'window',
                window: 'Counter-Strike 2:SDL_app:cs2.exe',
                priority: 2,
              },
            };
          }
          return {
            inputSettings: { url: 'http://127.0.0.1:3000/program', width: 1920, height: 1080 },
          };
        }
        if (requestType === 'GetInputPropertiesListPropertyItems') {
          return { propertyItems: [] };
        }
        if (requestType === 'GetSceneTransitionList') {
          return { transitions: [{ transitionName: 'Fade', transitionKind: 'fade_transition' }] };
        }
        if (requestType === 'SetCurrentProgramScene') {
          currentScene = String(requestData?.sceneName ?? currentScene);
          return {};
        }
        if (requestType === 'GetCurrentProgramScene')
          return { currentProgramSceneName: currentScene };
        if (requestType === 'GetCurrentSceneTransitionCursor') return { transitionCursor: 1 };
        return {};
      },
      onTransitionVideoEnded: () => () => undefined,
    };

    // Even if transition event never arrives, readback confirms OBS is already on gameplay.
    await expect(
      switchObsScene(obs, 'gameplay', 'http://127.0.0.1:3000', {
        transition: { kind: 'fade', durationMs: 1 },
      }),
    ).resolves.toBeUndefined();
    expect(currentScene).toBe(gameplayName);
  });

  it('does not invoke OBS while preconditions or structural OBS errors block a target, and recovers when conditions change', async () => {
    const base = loadBaseProjection();
    const currentProgram: ProgramProjection = {
      ...base,
      map: { ...base.map, phase: 'live', roundNumber: 1 },
      round: { phase: 'live', winnerSide: 'unknown' },
    };
    let telemetryFreshness: 'fresh' | 'stale' = 'stale';
    const coordinator = {
      getCurrent: () => ({
        program: currentProgram,
        operator: {
          runtime: { telemetryFreshness },
          matchContext: { freshness: 'fresh', origin: 'rivalhub' },
          identity: { state: 'matched' },
        },
      }),
      getBpAssessment: () => ({ readiness: 'unavailable' as const }),
    };

    let sceneMissing = true;
    const attempts: ProgramSceneId[] = [];
    const switched: ProgramSceneId[] = [];
    const bp = new BpSession(() => null);
    const controller = new ProgramSceneController(coordinator as never, bp, async (scene) => {
      attempts.push(scene);
      if (sceneMissing && scene === 'gameplay')
        throw new ObsVideoError('scene_target_unavailable', '缺少目标 OBS 场景「比赛中」。');
      switched.push(scene);
    });
    let now = 1000;
    const director = new ProgramDirector(
      coordinator as never,
      controller,
      bp,
      () => true,
      () => now,
      DEFAULT_PROGRAM_TIMINGS,
    );
    controller.attachDirector(director);

    // 1. Precondition unsatisfied (stale telemetry): blocked without touching OBS.
    await director.tick();
    now = 10_000;
    await director.tick();
    expect(attempts).toEqual([]);
    expect(director.get().mode).toBe('blocked');

    // 2. Structural missing-scene error attempts once and does not poll every 5s.
    telemetryFreshness = 'fresh';
    now = 11_000;
    await director.tick();
    expect(attempts.filter((s) => s === 'gameplay')).toHaveLength(1);
    expect(director.get().mode).toBe('blocked');
    const countBeforeWait = attempts.length;
    now = 40_000;
    await director.tick();
    expect(attempts.length).toBe(countBeforeWait);

    // 3. OBS change interrupt wakes the director and succeeds.
    sceneMissing = false;
    controller.obsProgramChanged();
    now = 40_100;
    await director.tick();
    expect(switched.at(-1)).toBe('gameplay');
    expect(director.get().mode).toBe('auto');
  });
});
