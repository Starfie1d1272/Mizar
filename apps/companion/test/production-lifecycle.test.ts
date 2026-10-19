import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
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

it('normal Host shutdown uses safe waiting/release and refuses entry until process stops', async () => {
  const calls: string[] = [];
  let safe = false;
  const scenes = {
    get: () => ({ revision: 'scene', active: 'waiting' }),
    selectWaitingForExit: () => {
      calls.push('waiting');
      return Promise.resolve(safe ? { ok: true } : { ok: false, message: 'waiting unconfirmed' });
    },
  } as unknown as ProgramSceneController;
  const app = Fastify();
  const lifecycle = registerProductionRoutes(app, {
    originPolicy: createLocalWebOriginPolicy(),
    hasContext: () => true,
    scenes,
    beforeFinish: () => {
      calls.push('camera-hold');
    },
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
    expect((await send('finish')).statusCode).toBe(409);
    expect(calls.splice(0)).toEqual(['camera-hold', 'waiting']);
    expect(lifecycle.get().mode).toBe('live');
    safe = true;
    expect((await send('shutdown')).statusCode).toBe(200);
    expect(calls).toEqual(['camera-hold', 'waiting', 'release']);
    expect(lifecycle.get()).toMatchObject({ mode: 'preparation', canEnter: false });
    expect((await send('enter')).statusCode).toBe(409);
    // Game restoration can fail after safety committed; another exit retries.
    expect((await send('shutdown')).statusCode).toBe(200);
    expect(calls).toEqual(['camera-hold', 'waiting', 'release', 'camera-hold', 'release']);
  } finally {
    await app.close();
  }
});

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

it('keeps recovered external Demo sessions cleanup-only at the real HTTP boundary', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mizar-external-demo-'));
  const requestId = 'ba05aade-2287-42be-9320-87abae5ac312';
  await writeFile(
    join(root, 'demo-test.json'),
    JSON.stringify({
      version: 'mizar.demo-test.v1',
      requestId,
      teamAName: 'A',
      teamBName: 'B',
      gameOwnership: 'external',
    }),
  );
  const app = buildApp({
    obsConfigPath: join(root, 'obs.json'),
    localTournamentPath: join(root, 'local.json'),
    matchManifestPath: join(root, 'match.json'),
    productRuntime: {
      artifactSha256: 'a'.repeat(64),
      gitSha: 'b'.repeat(40),
      instanceId: 'demo-recovery',
      controlToken: 'c'.repeat(64),
      stop: () => {},
    },
  });
  try {
    for (const action of ['resume', 'connect', 'configure', 'audition']) {
      const result = await app.inject({
        method: 'POST',
        url: '/operator/orchestration',
        headers: { origin: 'http://127.0.0.1:3000' },
        payload: { action },
      });
      expect(result.statusCode).toBe(409);
      expect(result.json().error).toBe('demo_camera_manual_only');
    }
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/operator/orchestration',
          headers: { origin: 'http://127.0.0.1:3000' },
          payload: { action: 'disconnect' },
        })
      ).statusCode,
    ).toBe(200);
    const body = { action: 'begin-demo', host: 'demo-host', requestId };
    expect(
      (await app.inject({ method: 'POST', url: '/operator/runtime/camera-session', payload: body }))
        .statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/operator/runtime/camera-session',
          headers: { 'x-runtime-token': 'c'.repeat(64) },
          payload: body,
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/operator/local-match/create',
          headers: { origin: 'http://127.0.0.1:3000' },
          payload: { teamA: 'Changed', teamB: 'B', format: 'bo1' },
        })
      ).statusCode,
    ).toBe(409);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
