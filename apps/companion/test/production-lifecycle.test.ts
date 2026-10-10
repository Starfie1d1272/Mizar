import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import type { ProjectionCoordinator } from '../src/projections/projection-coordinator.js';
import type { BpSession } from '../src/bp/controller.js';
import { ProgramSceneController } from '../src/program-scenes/controller.js';
import { registerProductionRoutes } from '../src/program-scenes/production.js';
import { createLocalWebOriginPolicy } from '../src/local-web/origin-policy.js';
import type { ContextEnvelope, MatchDocumentV1 } from '@mizar/core/match-context';
import { buildApp } from '../src/app.js';
import { registerUpdateRoutes } from '../src/updates/routes.js';
import type { UpdateManager } from '../src/updates/manager.js';
import type { ObsStatus } from '../src/obs/adapter.js';

it('requires only match context, preserves match through hide/resume/finish, and rejects stale commands', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mizar-lifecycle-'));
  const app = buildApp({
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
    select: () => {
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
      select,
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
  const claimNotification = vi.fn(() => ({ version: '1.1.0', notes: '可信更新' }));
  const manager = {
    status: () => ({ phase: 'ready', automatic: true, notificationPending: true }),
    desktopStartup,
    claimNotification,
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
  registerUpdateRoutes(app, {
    manager,
    production,
    scenes,
    originPolicy,
    controlToken: 'private-test-token',
    obs: () => Promise.resolve(obs),
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
    expect(claimNotification).not.toHaveBeenCalled();
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
    expect((await host('prepare')).statusCode).toBe(200);
    expect(production.get().canEnter).toBe(false);
    expect((await enter()).statusCode).toBe(409);
    expect(scenes.resumeAutomatic(scenes.get().revision)).toBe(false);
    expect((await host('release')).statusCode).toBe(200);
    expect((await enter()).statusCode).toBe(200);
  } finally {
    await app.close();
  }
});
