import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import type { ProjectionCoordinator } from '../src/projections/projection-coordinator.js';
import type { BpSession } from '../src/bp/controller.js';
import { ProgramSceneController } from '../src/program-scenes/controller.js';
import { registerProductionRoutes } from '../src/program-scenes/production.js';
import { createLocalWebOriginPolicy } from '../src/local-web/origin-policy.js';
import type { ContextEnvelope, MatchDocumentV1 } from '@mizar/core/match-context';
import { buildApp } from '../src/app.js';
import * as obsConfig from '../src/obs/config.js';

vi.mock('../src/obs/config.js', async (original) => ({
  ...(await original<typeof obsConfig>()),
  isObsProcessRunning: vi.fn(() => Promise.resolve(false)),
}));
import { registerUpdateRoutes } from '../src/updates/routes.js';
import type { UpdateManager } from '../src/updates/manager.js';
import type { ObsStatus } from '../src/obs/adapter.js';

const obsWire = vi.hoisted(() => ({
  connect: vi.fn(() => Promise.reject(new Error('ECONNREFUSED'))),
  disconnect: vi.fn(() => Promise.resolve()),
  call: vi.fn<(type: string, data?: Record<string, unknown>) => Promise<Record<string, unknown>>>(),
}));
vi.mock('obs-websocket-js', () => ({
  EventSubscription: { Outputs: 64 },
  OBSWebSocket: class {
    on() {
      return this;
    }
    off() {
      return this;
    }
    connect = obsWire.connect;
    disconnect = obsWire.disconnect;
    call = obsWire.call;
  },
}));
afterEach(() => {
  obsWire.connect.mockReset().mockRejectedValue(new Error('ECONNREFUSED'));
  obsWire.call.mockReset();
  vi.mocked(obsConfig.isObsProcessRunning).mockReset().mockResolvedValue(false);
});

it('requires only match context, preserves match through hide/resume/finish, and rejects stale commands', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mizar-lifecycle-'));
  await new obsConfig.ObsConfigStore(join(root, 'obs.json')).save(obsConfig.DEFAULT_OBS_CONFIG);
  const app = buildApp({
    obsConfigPath: join(root, 'obs.json'),
    matchManifestPath: join(root, 'match.json'),
    localTournamentPath: join(root, 'local.json'),
  });
  const headers = { origin: 'http://127.0.0.1:3000' };
  const get = async () =>
    (await app.inject('/local/v1/production')).json<{
      mode: string;
      revision: string;
      canEnter: boolean;
    }>();
  const send = async (action: string, revision: string) =>
    app.inject({
      method: 'POST',
      url: '/operator/production',
      headers,
      payload: { action, expectedRevision: revision },
    });
  try {
    const initial = await get();
    const scene = (await app.inject('/local/v1/program-scenes')).json<{ revision: string }>();
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/operator/program-scene',
          headers,
          payload: { sceneId: 'waiting', expectedRevision: scene.revision },
        })
      ).statusCode,
    ).toBe(409);
    expect(obsConfig.isObsProcessRunning).not.toHaveBeenCalled();
    expect(initial).toMatchObject({ mode: 'preparation', canEnter: false });
    expect((await send('enter', initial.revision)).statusCode).toBe(409);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/operator/local-match/create',
          headers,
          payload: { teamA: 'A', teamB: 'B', format: 'bo3' },
        })
      ).statusCode,
    ).toBe(200);
    const document = (await app.inject('/local/v1/match-document')).json<
      ContextEnvelope<MatchDocumentV1>
    >();
    expect((await send('enter', (await get()).revision)).json()).toMatchObject({ mode: 'live' });
    expect((await send('finish', initial.revision)).statusCode).toBe(409);
    expect((await send('hide', (await get()).revision)).json()).toMatchObject({ mode: 'hidden' });
    expect((await send('enter', (await get()).revision)).json()).toMatchObject({ mode: 'live' });
    expect((await send('finish', (await get()).revision)).json()).toMatchObject({
      mode: 'preparation',
    });
    expect((await app.inject('/local/v1/match-document')).json()).toEqual(document);
    expect((await app.inject('/local/v1/program-scenes')).json()).toMatchObject({
      active: 'waiting',
    });
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/operator/production',
          headers: { origin: 'https://foreign.test' },
          payload: { action: 'enter', expectedRevision: (await get()).revision },
        })
      ).statusCode,
    ).toBe(403);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('persists desktop visibility separately and cannot alter on-air HUD state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mizar-overlay-'));
  const app = buildApp({ localTournamentPath: join(root, 'local.json') });
  try {
    const hud = (await app.inject('/local/v1/hud-config')).body;
    const policy = (await app.inject('/local/v1/desktop-overlay')).json<{ revision: string }>();
    const response = await app.inject({
      method: 'POST',
      url: '/operator/desktop-overlay',
      headers: { origin: 'http://127.0.0.1:3000' },
      payload: {
        revision: policy.revision,
        enabled: true,
        visibility: { radar: true, 'top-score-bar': false },
      },
    });
    expect(response.statusCode).toBe(200);
    expect((await app.inject('/local/v1/hud-config')).body).toBe(hud);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/operator/desktop-overlay',
          headers: { origin: 'http://127.0.0.1:3000' },
          payload: { revision: policy.revision, enabled: false, visibility: {} },
        })
      ).statusCode,
    ).toBe(409);
  } finally {
    await app.close();
  }
  const restored = buildApp({ localTournamentPath: join(root, 'local.json') });
  try {
    expect((await restored.inject('/local/v1/desktop-overlay')).json()).toMatchObject({
      visibility: { radar: true, 'top-score-bar': false },
    });
  } finally {
    await restored.close();
    await rm(root, { recursive: true, force: true });
  }
});

it.each(['live', 'hidden'] as const)(
  'keeps %s retryable when waiting or release fails, switching to safety before releasing',
  async (mode) => {
    const calls: string[] = [];
    const switchObs = vi.fn((id: string) => {
      calls.push(id);
      return Promise.resolve();
    });
    const projections = {
      getCurrent: () => ({
        operator: {
          runtime: { telemetryFreshness: 'fresh' },
          matchContext: { freshness: 'fresh' },
          identity: { state: 'matched' },
        },
        program: {
          series: { bindingState: 'bound', status: 'live', maps: [] },
          map: { phase: 'live', score: { ct: 0, t: 0 } },
        },
      }),
      getBpAssessment: () => ({ readiness: 'missing' }),
    } as unknown as ProjectionCoordinator;
    const bp = { get: () => ({ projection: null, state: 'hidden' }) } as unknown as BpSession;
    const scenes = new ProgramSceneController(projections, bp, switchObs);
    await scenes.select('gameplay', scenes.get().revision);
    const release = vi.fn(() => {
      calls.push('release');
      return Promise.resolve();
    });
    const app = Fastify();
    const logged = vi.spyOn(app.log, 'error');
    const lifecycle = registerProductionRoutes(app, {
      originPolicy: createLocalWebOriginPolicy(),
      hasContext: () => true,
      scenes,
      release,
    });
    const send = (action: string) =>
      app.inject({
        method: 'POST',
        url: '/operator/production',
        headers: { origin: 'http://127.0.0.1:3000' },
        payload: { action, expectedRevision: lifecycle.get().revision },
      });
    try {
      await send('enter');
      if (mode === 'hidden') await send('hide');
      const before = lifecycle.get();
      calls.length = 0;
      switchObs.mockRejectedValueOnce(new Error('OBS down'));
      expect((await send('finish')).statusCode).toBe(409);
      expect(release).not.toHaveBeenCalled();
      expect(lifecycle.get()).toEqual(before);
      expect(scenes.get().active).toBe('gameplay');
      release.mockImplementationOnce(() => {
        calls.push('release');
        return Promise.reject(new Error('RivalHub unavailable'));
      });
      calls.length = 0;
      expect((await send('finish')).statusCode).toBe(409);
      expect(calls).toEqual(['waiting', 'release']);
      const evidence: unknown = logged.mock.calls.at(-1)?.[0];
      expect(evidence).toMatchObject({
        stage: 'production_release',
        diagnostic: {
          error: { message: 'RivalHub unavailable' },
        },
      });
      expect(scenes.get().active).toBe('waiting');
      expect(lifecycle.get()).toEqual(before);
      expect((await send('finish')).statusCode).toBe(200);
      expect(lifecycle.get().mode).toBe('preparation');
      expect(release).toHaveBeenCalledTimes(2);
    } finally {
      await app.close();
    }
  },
);

it('normal Host shutdown uses safe waiting/release and refuses entry until process stops', async () => {
  const calls: string[] = [];
  const scenes = {
    get: () => ({ revision: 'scene', active: 'waiting' }),
    selectWaitingForExit: () => {
      calls.push('waiting');
      return Promise.resolve({ ok: true });
    },
  } as unknown as ProgramSceneController;
  const app = Fastify();
  const lifecycle = registerProductionRoutes(app, {
    originPolicy: createLocalWebOriginPolicy(),
    hasContext: () => true,
    scenes,
    release: () => {
      calls.push('release');
      return Promise.resolve();
    },
  });
  const send = (action: string) =>
    app.inject({
      method: 'POST',
      url: '/operator/production',
      headers: { origin: 'http://127.0.0.1:3000' },
      payload: { action, expectedRevision: lifecycle.get().revision },
    });
  try {
    await send('enter');
    expect((await send('shutdown')).statusCode).toBe(200);
    expect(calls).toEqual(['waiting', 'release']);
    expect(lifecycle.get()).toMatchObject({ mode: 'preparation', canEnter: false });
    expect((await send('enter')).statusCode).toBe(409);
    // Game restoration can fail after safety committed; another exit retries.
    expect((await send('shutdown')).statusCode).toBe(200);
    expect(calls).toEqual(['waiting', 'release', 'release']);
  } finally {
    await app.close();
  }
});

it('idle Host shutdown needs no OBS scene and failed safety keeps live cleanup retryable', async () => {
  const select = vi.fn(() => Promise.resolve({ ok: false, message: 'OBS 未连接' }));
  const release = vi.fn(() => Promise.resolve());
  const app = Fastify();
  const lifecycle = registerProductionRoutes(app, {
    originPolicy: createLocalWebOriginPolicy(),
    hasContext: () => true,
    scenes: {
      get: () => ({ revision: 'scene', active: 'waiting' }),
      selectWaitingForExit: select,
    } as unknown as ProgramSceneController,
    release,
  });
  const send = (action: string) =>
    app.inject({
      method: 'POST',
      url: '/operator/production',
      headers: { origin: 'http://127.0.0.1:3000' },
      payload: { action, expectedRevision: lifecycle.get().revision },
    });
  try {
    await send('enter');
    expect((await send('shutdown')).statusCode).toBe(409);
    expect(lifecycle.get()).toMatchObject({ mode: 'live', canEnter: true });
    expect(release).not.toHaveBeenCalled();
    select.mockResolvedValueOnce({ ok: true, message: '' });
    expect((await send('finish')).statusCode).toBe(200);
    select.mockClear();
    release.mockClear();
    expect((await send('shutdown')).statusCode).toBe(200);
    expect(select).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
  } finally {
    await app.close();
  }
});

it('requires the private Host and idle production, then prevents entry until upgrade preparation is released', async () => {
  // Trust and download lifecycle have their own owner; this seam exercises the control boundary only.
  const prepare = vi.fn(() => Promise.resolve({ schemaVersion: 1 }));
  const desktopStartup = vi.fn();
  const notification = vi.fn(() => ({ version: '1.1.0', notes: '可信更新' }));
  const dismissNotification = vi.fn();
  const manager = {
    status: () => ({ phase: 'ready', automatic: true, notificationPending: true }),
    desktopStartup,
    notification,
    dismissNotification,
    failure: vi.fn(),
    prepare,
    release: vi.fn(),
    start: vi.fn(),
    close: () => Promise.resolve(),
  } as unknown as UpdateManager;
  const projections = {
    getCurrent: () => ({
      operator: { runtime: {}, matchContext: {}, identity: {} },
      program: {},
    }),
    getBpAssessment: () => ({ readiness: 'missing' }),
  } as unknown as ProjectionCoordinator;
  const scenes = new ProgramSceneController(projections, {} as BpSession);
  const app = Fastify();
  const originPolicy = createLocalWebOriginPolicy();
  const production = registerProductionRoutes(app, {
    originPolicy,
    scenes,
    hasContext: () => true,
    release: () => Promise.resolve(),
  });
  let obs = { connection: 'connected', streaming: false, recording: false } as ObsStatus;
  const obsProcessRunning = vi.fn<() => Promise<boolean>>().mockResolvedValue(true);
  const warn = vi.spyOn(app.log, 'warn');
  registerUpdateRoutes(app, {
    manager,
    production,
    scenes,
    originPolicy,
    controlToken: 'private-test-token',
    obs: () => Promise.resolve(obs),
    obsProcessRunning,
  });
  const host = (action: string, headers = { 'x-runtime-token': 'private-test-token' }) =>
    app.inject({
      method: 'POST',
      url: '/operator/updates/install-plan',
      headers,
      payload: { action },
    });
  const enter = () =>
    app.inject({
      method: 'POST',
      url: '/operator/production',
      headers: { origin: 'http://127.0.0.1:3000' },
      payload: { action: 'enter', expectedRevision: production.get().revision },
    });
  const notify = () =>
    app.inject({
      method: 'POST',
      url: '/operator/updates',
      headers: { origin: 'http://127.0.0.1:3000' },
      payload: { action: 'notify', version: '1.1.0' },
    });
  try {
    const startup = (headers: Record<string, string>) =>
      app.inject({
        method: 'POST',
        url: '/operator/updates/install-plan',
        headers,
        payload: { action: 'startup', sessionId: `${'a'.repeat(32)}-${'b'.repeat(8)}` },
      });
    expect((await startup({})).statusCode).toBe(403);
    expect(
      (await startup({ origin: 'http://127.0.0.1:3000', 'x-runtime-token': 'private-test-token' }))
        .statusCode,
    ).toBe(403);
    expect((await startup({ 'x-runtime-token': 'private-test-token' })).statusCode).toBe(200);
    expect(desktopStartup).toHaveBeenCalledTimes(1);
    expect((await host('prepare', { 'x-runtime-token': '' })).statusCode).toBe(403);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/operator/updates/install-plan',
          headers: { origin: 'http://127.0.0.1:3000', 'x-runtime-token': 'private-test-token' },
          payload: { action: 'prepare', installer: 'attacker.exe' },
        })
      ).statusCode,
    ).toBe(403);
    expect(prepare).not.toHaveBeenCalled();
    const initialRevision = (await app.inject('/local/v1/updates')).json<{
      productionRevision: string;
    }>().productionRevision;
    expect(initialRevision).toBe(production.get().revision);
    await enter();
    expect((await notify()).json<{ notification: unknown }>().notification).toBeNull();
    expect(notification).not.toHaveBeenCalled();
    expect((await host('prepare')).statusCode).toBe(409);
    await app.inject({
      method: 'POST',
      url: '/operator/production',
      headers: { origin: 'http://127.0.0.1:3000' },
      payload: { action: 'hide', expectedRevision: production.get().revision },
    });
    expect((await host('prepare')).statusCode).toBe(409);
    await app.inject({
      method: 'POST',
      url: '/operator/production',
      headers: { origin: 'http://127.0.0.1:3000' },
      payload: { action: 'finish', expectedRevision: production.get().revision },
    });
    expect(
      (await app.inject('/local/v1/updates')).json<{ productionRevision: string }>()
        .productionRevision,
    ).not.toBe(initialRevision);
    for (const state of [
      { connection: 'unavailable', streaming: false, recording: false },
      { connection: 'connected', streaming: true, recording: false },
      { connection: 'connected', streaming: false, recording: true },
    ]) {
      obs = state as ObsStatus;
      expect((await notify()).json<{ notification: unknown }>().notification).toBeNull();
      expect((await host('prepare')).statusCode).toBe(409);
      expect(
        (await app.inject('/local/v1/updates')).json<{ installBlockedReason: string | null }>()
          .installBlockedReason,
      ).toBeTruthy();
    }
    obs = { connection: 'connected', streaming: false, recording: false } as ObsStatus;
    expect((await notify()).json<{ notification: unknown }>().notification).toEqual({
      version: '1.1.0',
      notes: '可信更新',
    });
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/operator/updates',
          headers: { origin: 'http://127.0.0.1:3000' },
          payload: { action: 'dismiss-notification', version: '1.1.0' },
        })
      ).statusCode,
    ).toBe(200);
    expect(dismissNotification).toHaveBeenCalledWith('1.1.0');
    expect((await host('prepare')).statusCode).toBe(200);
    expect(production.get().canEnter).toBe(false);
    expect((await enter()).statusCode).toBe(409);
    expect(scenes.resumeAutomatic(scenes.get().revision)).toBe(false);
    expect((await host('release')).statusCode).toBe(200);
    // Offline OBS is optional when a fresh process probe proves it is not running.
    obs = { connection: 'unavailable', streaming: false, recording: false } as ObsStatus;
    obsProcessRunning.mockResolvedValue(false);
    expect(
      (await app.inject('/local/v1/updates')).json<{ installBlockedReason: string | null }>()
        .installBlockedReason,
    ).toBeNull();
    expect((await notify()).json<{ notification: unknown }>().notification).not.toBeNull();
    // A process started after the page's assessment must still block the Host plan.
    obsProcessRunning.mockResolvedValue(true);
    expect((await host('prepare')).statusCode).toBe(409);
    expect((await host('prepare')).json<{ message: string }>().message).toContain(
      '正在运行但未连接',
    );
    obsProcessRunning.mockRejectedValue(new Error('probe timed out'));
    expect((await host('prepare')).statusCode).toBe(409);
    expect((await host('prepare')).json<{ message: string }>().message).toContain(
      '进程状态检测未完成',
    );
    expect(JSON.stringify(warn.mock.calls)).toContain('probe timed out');
    obsProcessRunning.mockResolvedValue(false);
    expect((await host('prepare')).statusCode).toBe(200);
    expect(production.get().canEnter).toBe(false);
    expect((await production.shutdown()).code).toBe(200);
    expect((await host('release')).statusCode).toBe(200);
    expect((await enter()).statusCode).toBe(409); // Successful shutdown keeps entry closed.
  } finally {
    await app.close();
  }
});

it.each(['finish', 'shutdown'] as const)(
  'real production adapter keeps unknown/running OBS retryable and completes %s after verified absence',
  async (action) => {
    const root = await mkdtemp(join(tmpdir(), 'mizar-exit-obs-'));
    await new obsConfig.ObsConfigStore(join(root, 'obs.json')).save(obsConfig.DEFAULT_OBS_CONFIG);
    const app = buildApp({
      obsConfigPath: join(root, 'obs.json'),
      matchManifestPath: join(root, 'match.json'),
      localTournamentPath: join(root, 'local.json'),
    });
    const headers = { origin: 'http://127.0.0.1:3000' };
    const get = async () =>
      (await app.inject('/local/v1/production')).json<{ mode: string; revision: string }>();
    const send = async (action: string) =>
      app.inject({
        method: 'POST',
        url: '/operator/production',
        headers,
        payload: { action, expectedRevision: (await get()).revision },
      });
    try {
      await app.inject({
        method: 'POST',
        url: '/operator/local-match/create',
        headers,
        payload: { teamA: 'A', teamB: 'B', format: 'bo3' },
      });
      expect((await send('enter')).statusCode).toBe(200);
      const before = await get();
      vi.mocked(obsConfig.isObsProcessRunning).mockRejectedValue(new Error('probe timeout'));
      const unknown = await send(action);
      expect(unknown.statusCode).toBe(409);
      expect(unknown.json<{ message: string }>().message).toContain('运行状态未确认');
      expect(await get()).toEqual(before);
      vi.mocked(obsConfig.isObsProcessRunning).mockResolvedValue(true);
      const running = await send(action);
      expect(running.statusCode).toBe(409);
      expect(running.json<{ message: string }>().message).toContain(
        '确认停止推流与录制并关闭 OBS 后重试',
      );
      expect(await get()).toEqual(before);
      vi.mocked(obsConfig.isObsProcessRunning).mockResolvedValue(false);
      expect((await send(action)).statusCode).toBe(200);
      expect(await get()).toMatchObject({ mode: 'preparation' });
      expect(obsWire.call).not.toHaveBeenCalled();
      expect((await send(action)).statusCode).toBe(200);
    } finally {
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

it.each(['stream', 'record'] as const)(
  'real adapter requires confirmed waiting while %s is active and never stops or closes OBS',
  async (_output) => {
    const { OBS_COLLECTION, obsDesiredScenes } = await import('../src/obs/desired-state.js');
    const root = await mkdtemp(join(tmpdir(), 'mizar-exit-onair-'));
    const waiting = obsDesiredScenes('http://127.0.0.1:3000').find(
      (scene) => scene.id === 'waiting',
    )!.sceneName;
    let scene = 'external-scene';
    let fail = true;
    obsWire.connect.mockResolvedValue(undefined as never);
    obsWire.call.mockImplementation(async (type, data) => {
      await Promise.resolve();
      if (type === 'GetSceneCollectionList') return { currentSceneCollectionName: OBS_COLLECTION };
      if (type === 'GetSceneList')
        return { scenes: [{ sceneName: waiting }], currentProgramSceneName: scene };
      if (type === 'GetSceneTransitionList')
        return { transitions: [{ transitionKind: 'cut_transition', transitionName: 'Cut' }] };
      if (type === 'SetSceneSceneTransitionOverride') return {};
      if (type === 'SetCurrentProgramScene') {
        if (fail) throw new Error('switch failed');
        scene = String(data?.sceneName);
        return {};
      }
      if (type === 'GetCurrentProgramScene') return { currentProgramSceneName: scene };
      if (type === 'GetCurrentSceneTransitionCursor') return { transitionCursor: 1 };
      // An output can be active throughout the safe cut. No stop/close intent is allowed.
      if (type === 'GetStreamStatus' || type === 'GetRecordStatus')
        return {
          outputActive: type === (_output === 'stream' ? 'GetStreamStatus' : 'GetRecordStatus'),
        };
      throw new Error(`unexpected OBS request: ${type}`);
    });
    vi.mocked(obsConfig.isObsProcessRunning).mockResolvedValue(true);
    const app = buildApp({
      obsConfigPath: join(root, 'obs.json'),
      matchManifestPath: join(root, 'match.json'),
      localTournamentPath: join(root, 'local.json'),
    });
    const headers = { origin: 'http://127.0.0.1:3000' };
    const send = async (action: string) =>
      app.inject({
        method: 'POST',
        url: '/operator/production',
        headers,
        payload: {
          action,
          expectedRevision: (await app.inject('/local/v1/production')).json<{ revision: string }>()
            .revision,
        },
      });
    try {
      await app.inject({
        method: 'POST',
        url: '/operator/local-match/create',
        headers,
        payload: { teamA: 'A', teamB: 'B', format: 'bo3' },
      });
      expect((await send('enter')).statusCode).toBe(200);
      expect((await app.inject('/local/v1/obs/outputs')).json()).toMatchObject({
        [_output]: { active: true, phase: 'active' },
      });
      const before = (await app.inject('/local/v1/production')).json<{
        mode: string;
        revision: string;
      }>();
      expect((await send('finish')).statusCode).toBe(409);
      expect((await app.inject('/local/v1/production')).json()).toEqual(before);
      fail = false;
      obsWire.call.mockClear();
      vi.mocked(obsConfig.isObsProcessRunning).mockClear();
      expect((await send('finish')).statusCode).toBe(200);
      expect(scene).toBe(waiting);
      expect(vi.mocked(obsConfig.isObsProcessRunning)).not.toHaveBeenCalled();
      expect(obsWire.call.mock.calls.map(([type]) => type)).toEqual([
        'GetSceneCollectionList',
        'GetSceneList',
        'GetSceneTransitionList',
        'SetSceneSceneTransitionOverride',
        'SetCurrentProgramScene',
        'GetCurrentProgramScene',
      ]);
      // Previously participating OBS: disconnect still blocks until closure is proved.
      obsWire.connect.mockRejectedValue(new Error('ECONNREFUSED'));
      expect((await send('finish')).statusCode).toBe(409);
      vi.mocked(obsConfig.isObsProcessRunning).mockResolvedValue(false);
      expect((await send('finish')).statusCode).toBe(200);
    } finally {
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
