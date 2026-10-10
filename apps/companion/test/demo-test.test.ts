import type { ContextEnvelope, MatchDocumentV1 } from '@mizar/core/match-context';
import type { ProgramSceneState } from '@mizar/protocol/program-scenes';
import type { DemoTestView } from '../src/demo-test/controller.js';
type ProductionView = { mode: string; revision: string; canEnter: boolean };
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { MatchContextController } from '../src/match-context/controller.js';
import { buildApp } from '../src/app.js';
import { ObsAdapter, type ObsStatus } from '../src/obs/adapter.js';
import { createProgramRuntime } from '../src/runtime/program-runtime.js';
import { JsonSeriesProgressCheckpointStore } from '../src/series-progress/checkpoint-store.js';
import { ProgramSceneController } from '../src/program-scenes/controller.js';

const browser = { origin: 'http://127.0.0.1:3000' };
const host = { 'x-runtime-token': 'host-secret' };
const obs: ObsStatus = {
  connection: 'connected',
  currentScene: null,
  port: 4455,
  streaming: false,
  recording: false,
  passwordConfigured: true,
  video: null,
  findings: [],
};
const apps: ReturnType<typeof buildApp>[] = [];
const roots: string[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'mizar-demo-test-'));
  roots.push(root);
  await writeFile(
    join(root, 'outbox.json'),
    JSON.stringify({ version: 'mizar.reliable-outbox.v1', records: [] }),
  );
  const checkpoint = new JsonSeriesProgressCheckpointStore({ filePath: join(root, 'series.json') });
  const runtime = createProgramRuntime('demo-test-producer', {
    seriesProgressCheckpointStore: checkpoint,
  });
  const options = {
    localTournamentPath: join(root, 'local.json'),
    matchManifestPath: join(root, 'lkg.json'),
    obsConfigPath: join(root, 'obs.json'),
    reliableOutboxPath: join(root, 'outbox.json'),
    gsiToken: 'gsi-secret',
    programRuntime: runtime,
    productRuntime: {
      appVersion: '1.0.0',
      artifactSha256: 'test',
      gitSha: 'test',
      instanceId: 'test',
      controlToken: 'host-secret',
      stop: vi.fn(),
    },
  };
  const status = vi.spyOn(ObsAdapter.prototype, 'status').mockResolvedValue(obs);
  const switchObs = vi.spyOn(ObsAdapter.prototype, 'switchScene').mockResolvedValue();
  const app = buildApp(options);
  apps.push(app);
  await app.ready();
  const requestId = randomUUID();
  const command = (action: string, extra = {}, headers = host) =>
    app.inject({
      method: 'POST',
      url: '/operator/runtime/demo-test',
      headers,
      payload: { action, requestId, ...extra },
    });
  const frame = () =>
    app.inject({
      method: 'POST',
      url: '/gsi',
      payload: {
        auth: { token: 'gsi-secret' },
        provider: { appid: 730, timestamp: Date.now() / 1000 },
        map: {
          name: 'de_mirage',
          phase: 'live',
          round: 0,
          team_ct: { score: 0 },
          team_t: { score: 0 },
        },
        round: { phase: 'live' },
        allplayers: {
          '76561198000000001': {
            name: 'Demo player',
            team: 'CT',
            observer_slot: 1,
            state: { health: 100 },
          },
        },
      },
    });
  return { root, app, options, runtime, checkpoint, command, requestId, frame, switchObs, status };
}

it('isolates real demo observations, preserves formal storage/checkpoint, and restores only after Host completion', async () => {
  const h = await setup();
  expect(
    (
      await h.app.inject({
        method: 'POST',
        url: '/operator/local-match/create',
        headers: browser,
        payload: { teamA: 'Formal A', teamB: 'Formal B', format: 'bo3' },
      })
    ).statusCode,
  ).toBe(200);
  const formal = (await h.app.inject('/local/v1/match-document')).json<
    ContextEnvelope<MatchDocumentV1>
  >();
  const exitRequest = (payload: Record<string, unknown>) =>
    h.app.inject({
      method: 'POST',
      url: '/operator/runtime/local-match-exit',
      headers: host,
      payload,
    });
  const qualification = (await exitRequest({ action: 'prepare' })).json<{
    qualification: unknown;
  }>().qualification;
  expect((await exitRequest({ action: 'confirm', qualification })).statusCode).toBe(200);
  await h.runtime.flushSeriesProgressCheckpoint();
  const storage = await readFile(join(h.root, 'local.json'), 'utf8');
  const saved = await readFile(join(h.root, 'series.json'), 'utf8');
  const outboxSaved = await readFile(join(h.root, 'outbox.json'), 'utf8');
  const checkpointLoad = vi.spyOn(h.checkpoint, 'load');
  const checkpointSave = vi.spyOn(h.checkpoint, 'save');
  const priorSession = h.runtime.getCurrentState().liveSession;
  expect((await h.command('begin', { teamAName: 'Demo A' })).json()).toMatchObject({
    phase: 'starting',
    active: true,
    teamAName: 'Demo A',
    teamBName: 'B',
    dataReady: false,
  });
  expect(h.runtime.getCurrentState().liveSession).not.toEqual(priorSession);
  expect((await exitRequest({ action: 'prepare' })).statusCode).toBe(409);
  expect((await h.app.inject('/local/v1/tournament')).json()).toMatchObject({
    canConfirmLocalExit: false,
    canReleaseLocalSelection: false,
  });
  const trial = (await h.app.inject('/local/v1/match-document')).json<
    ContextEnvelope<MatchDocumentV1>
  >();
  expect(trial.document).toMatchObject({
    competition: null,
    format: 'bo1',
    entrants: {
      a: { name: 'Demo A', players: [] },
      b: { name: 'B', players: [] },
    },
  });
  expect((await h.command('begin')).statusCode).toBe(200);
  await h.frame();
  expect(h.runtime.getCurrentState().programTelemetry).toBeUndefined();
  for (const url of [
    '/operator/local-match/create',
    '/operator/online-match/select',
    '/operator/program-director',
    '/operator/updates/check',
  ])
    expect(
      (await h.app.inject({ method: 'POST', url, headers: browser, payload: {} })).statusCode,
    ).toBe(409);
  const production = (await h.app.inject('/local/v1/production')).json<ProductionView>();
  expect(production.canEnter).toBe(false);
  expect(
    (
      await h.app.inject({
        method: 'POST',
        url: '/operator/production',
        headers: browser,
        payload: { action: 'enter', expectedRevision: production.revision },
      })
    ).statusCode,
  ).toBe(409);
  expect((await h.command('playing')).statusCode).toBe(200);
  expect((await h.app.inject('/local/v1/production')).json<ProductionView>()).toMatchObject({
    mode: 'live',
  });
  await h.frame();
  await vi.waitFor(() => expect(h.switchObs).toHaveBeenCalledWith('gameplay', expect.anything()));
  expect((await h.app.inject('/local/v1/demo-test')).json<DemoTestView>()).toMatchObject({
    phase: 'playing',
    dataReady: true,
  });
  expect((await h.app.inject('/local/v1/program-scenes')).json<ProgramSceneState>()).toMatchObject({
    active: 'gameplay',
    director: { mode: 'manual' },
  });
  expect((await h.app.inject('/local/v1/live-snapshot')).statusCode).toBe(503);
  const sceneState = (await h.app.inject('/local/v1/program-scenes')).json<ProgramSceneState>();
  expect(
    (
      await h.app.inject({
        method: 'POST',
        url: '/operator/program-scene',
        headers: browser,
        payload: { sceneId: 'waiting', expectedRevision: sceneState.revision },
      })
    ).statusCode,
  ).toBe(200);
  const waitState = (await h.app.inject('/local/v1/program-scenes')).json<ProgramSceneState>();
  expect(
    (
      await h.app.inject({
        method: 'POST',
        url: '/operator/program-scene',
        headers: browser,
        payload: { sceneId: 'gameplay', expectedRevision: waitState.revision },
      })
    ).statusCode,
  ).toBe(200);
  await h.runtime.flushSeriesProgressCheckpoint();
  expect(await readFile(join(h.root, 'series.json'), 'utf8')).toBe(saved);
  expect(await readFile(join(h.root, 'local.json'), 'utf8')).toBe(storage);
  expect(await readFile(join(h.root, 'outbox.json'), 'utf8')).toBe(outboxSaved);
  expect(checkpointLoad).not.toHaveBeenCalled();
  expect(checkpointSave).not.toHaveBeenCalled();
  expect((await h.command('cancel')).statusCode).toBe(409);
  expect((await h.command('complete')).statusCode).toBe(409);
  h.switchObs.mockRejectedValueOnce(new Error('OBS unavailable'));
  expect((await h.command('finish')).statusCode).toBe(409);
  expect((await h.app.inject('/local/v1/demo-test')).json<DemoTestView>()).toMatchObject({
    active: true,
    phase: 'stopping',
  });
  await h.frame();
  expect((await h.command('complete')).statusCode).toBe(409);
  expect((await h.command('finish')).json()).toMatchObject({ phase: 'stopping' });
  await h.frame();
  expect(h.runtime.getCurrentState().programTelemetry).toBeUndefined();
  expect(
    (await h.app.inject('/local/v1/match-document')).json<ContextEnvelope<MatchDocumentV1>>()
      .document.matchId,
  ).toBe(trial.document.matchId);
  expect((await h.command('complete')).json()).toMatchObject({ active: false, phase: 'idle' });
  expect((await h.app.inject('/local/v1/tournament')).json()).toMatchObject({
    canReleaseLocalSelection: false,
  });
  expect((await exitRequest({ action: 'confirm', qualification })).statusCode).toBe(409);
  expect((await h.command('complete')).statusCode).toBe(200);
  expect(
    (await h.app.inject('/local/v1/match-document')).json<ContextEnvelope<MatchDocumentV1>>()
      .document,
  ).toEqual(formal.document);
  await h.runtime.flushSeriesProgressCheckpoint();
  expect(await readFile(join(h.root, 'series.json'), 'utf8')).toBe(saved);
  await h.frame();
  expect(h.runtime.getCurrentState().programTelemetry).toBeUndefined();
  const resumed = (await h.app.inject('/local/v1/production')).json<ProductionView>();
  expect(
    (
      await h.app.inject({
        method: 'POST',
        url: '/operator/production',
        headers: browser,
        payload: { action: 'enter', expectedRevision: resumed.revision },
      })
    ).statusCode,
  ).toBe(200);
  await h.frame();
  expect(h.runtime.getCurrentState().programTelemetry).toBeDefined();
});

it('keeps failed initial gameplay takes actionable, preserves safe output, and bounds automatic retries', async () => {
  const h = await setup();
  const log = vi.spyOn(h.app.log, 'error');
  expect((await h.command('begin')).statusCode).toBe(200);
  expect((await h.command('playing')).statusCode).toBe(200);
  const cause = Object.assign(new Error('WebSocket connection reset'), { code: 'ECONNRESET' });
  const select = vi
    .spyOn(ProgramSceneController.prototype, 'select')
    .mockRejectedValueOnce(new Error('OBS request failed', { cause }));
  await h.frame();
  await vi.waitFor(() => expect(log).toHaveBeenCalledOnce());
  const evidence = JSON.stringify(log.mock.calls);
  expect(evidence).toContain('initial_gameplay_take');
  expect(evidence).toContain('ECONNRESET');
  expect(evidence).toContain('WebSocket connection reset');
  expect((await h.app.inject('/local/v1/program-scenes')).json<ProgramSceneState>().active).toBe(
    'waiting',
  );
  for (let i = 0; i < 4; i++) await h.frame();
  expect(select).toHaveBeenCalledOnce();
  expect(log).toHaveBeenCalledOnce();
  const clock = vi.spyOn(performance, 'now').mockReturnValue(performance.now() + 5001);
  await h.frame();
  await vi.waitFor(() => expect(h.switchObs).toHaveBeenCalledWith('gameplay', expect.anything()));
  clock.mockRestore();
  expect((await h.app.inject('/local/v1/program-scenes')).json<ProgramSceneState>().active).toBe(
    'gameplay',
  );
});

it('requires the private Host capability and preparation with connected non-streaming OBS', async () => {
  const h = await setup();
  expect((await h.command('begin', {}, { 'x-runtime-token': 'wrong' })).statusCode).toBe(403);
  expect((await h.command('begin', {}, { ...host, ...browser })).statusCode).toBe(403);
  expect((await h.command('begin', { demoPath: 'C:/secret.dem' })).statusCode).toBe(400);
  h.status.mockResolvedValueOnce({ ...obs, streaming: true });
  expect((await h.command('begin')).statusCode).toBe(409);
  h.status.mockResolvedValueOnce({
    ...obs,
    connection: 'unavailable',
  });
  expect((await h.command('begin')).statusCode).toBe(409);
  expect((await h.command('begin')).statusCode).toBe(200);
  expect((await h.command('cancel')).json()).toMatchObject({ phase: 'idle' });
});

it('quarantines a restart marker before formal autoload or GSI acceptance, including unreadable markers', async () => {
  const h = await setup();
  await h.app.inject({
    method: 'POST',
    url: '/operator/local-match/create',
    headers: browser,
    payload: { teamA: 'Saved A', teamB: 'Saved B', format: 'bo1' },
  });
  const formal = (await h.app.inject('/local/v1/match-document')).json<
    ContextEnvelope<MatchDocumentV1>
  >().document;
  await h.runtime.flushSeriesProgressCheckpoint();
  const saved = await readFile(join(h.root, 'series.json'), 'utf8');
  expect((await h.command('begin')).statusCode).toBe(200);
  await h.app.close();
  apps.splice(apps.indexOf(h.app), 1);
  const runtime = createProgramRuntime('restarted', {
    seriesProgressCheckpointStore: h.checkpoint,
  });
  const app = buildApp({ ...h.options, programRuntime: runtime });
  apps.push(app);
  const state = (await app.inject('/local/v1/demo-test')).json<DemoTestView>();
  expect(state).toMatchObject({ phase: 'recovery', active: true, requestId: h.requestId });
  expect((await app.inject('/local/v1/match-document')).statusCode).toBe(404);
  expect(await readFile(join(h.root, 'series.json'), 'utf8')).toBe(saved);
  await app.inject({
    method: 'POST',
    url: '/gsi',
    payload: { auth: { token: 'gsi-secret' }, map: { name: 'de_nuke' } },
  });
  expect(runtime.getCurrentState().programTelemetry).toBeUndefined();
  const complete = await app.inject({
    method: 'POST',
    url: '/operator/runtime/demo-test',
    headers: host,
    payload: { action: 'complete', requestId: h.requestId },
  });
  expect(complete.statusCode).toBe(200);
  expect(
    (await app.inject('/local/v1/match-document')).json<ContextEnvelope<MatchDocumentV1>>()
      .document,
  ).toEqual(formal);
  await app.close();
  apps.splice(apps.indexOf(app), 1);
  await writeFile(join(h.root, 'demo-test.json'), '{invalid');
  const invalid = buildApp({
    ...h.options,
    programRuntime: createProgramRuntime('invalid-marker'),
  });
  apps.push(invalid);
  expect((await invalid.inject('/local/v1/demo-test')).json<DemoTestView>()).toMatchObject({
    active: true,
    phase: 'recovery',
  });
  expect((await invalid.inject('/local/v1/match-document')).statusCode).toBe(404);
});

it('normal production finish and Host shutdown keep the trial recovery marker until explicit completion', async () => {
  const h = await setup();
  expect((await h.command('begin')).statusCode).toBe(200);
  expect((await h.command('playing')).statusCode).toBe(200);
  await h.frame();
  await vi.waitFor(() => expect(h.switchObs).toHaveBeenCalled());
  const production = (await h.app.inject('/local/v1/production')).json<ProductionView>();
  expect(
    (
      await h.app.inject({
        method: 'POST',
        url: '/operator/production',
        headers: browser,
        payload: { action: 'finish', expectedRevision: production.revision },
      })
    ).statusCode,
  ).toBe(200);
  expect((await h.app.inject('/local/v1/demo-test')).json<DemoTestView>()).toMatchObject({
    active: true,
    phase: 'stopping',
  });
  expect((await h.app.inject('/local/v1/production')).json<ProductionView>()).toMatchObject({
    mode: 'preparation',
    canEnter: false,
  });
  expect(
    (JSON.parse(await readFile(join(h.root, 'demo-test.json'), 'utf8')) as { requestId: string })
      .requestId,
  ).toBe(h.requestId);
  expect(
    (await h.app.inject({ method: 'POST', url: '/operator/runtime/stop', headers: host }))
      .statusCode,
  ).toBe(409);
  expect(h.options.productRuntime.stop).not.toHaveBeenCalled();
  expect((await h.app.inject('/local/v1/demo-test')).json<DemoTestView>()).toMatchObject({
    active: true,
  });
  expect((await h.command('complete')).statusCode).toBe(200);
  expect((await h.app.inject('/local/v1/demo-test')).json<DemoTestView>()).toMatchObject({
    active: false,
  });
  expect(
    (await h.app.inject({ method: 'POST', url: '/operator/runtime/stop', headers: host }))
      .statusCode,
  ).toBe(202);
  await vi.waitFor(() => expect(h.options.productRuntime.stop).toHaveBeenCalledOnce());
});

it('reports only fresh spectator map data as ready and never takes a menu frame', async () => {
  const h = await setup();
  expect((await h.command('begin')).statusCode).toBe(200);
  expect((await h.command('playing')).statusCode).toBe(200);
  await h.app.inject({
    method: 'POST',
    url: '/gsi',
    payload: { auth: { token: 'gsi-secret' }, provider: { appid: 730 } },
  });
  expect((await h.app.inject('/local/v1/demo-test')).json<DemoTestView>()).toMatchObject({
    dataReady: false,
  });
  expect(h.switchObs).not.toHaveBeenCalled();
  await h.app.inject({
    method: 'POST',
    url: '/gsi',
    payload: {
      auth: { token: 'gsi-secret' },
      map: { name: 'de_mirage', phase: 'live' },
      allplayers: {},
    },
  });
  expect((await h.app.inject('/local/v1/demo-test')).json<DemoTestView>()).toMatchObject({
    dataReady: false,
  });
  expect(h.switchObs).not.toHaveBeenCalled();
  const scene = (await h.app.inject('/local/v1/program-scenes')).json<ProgramSceneState>();
  expect(
    (
      await h.app.inject({
        method: 'POST',
        url: '/operator/program-scene',
        headers: browser,
        payload: { sceneId: 'gameplay', expectedRevision: scene.revision },
      })
    ).statusCode,
  ).toBe(409);
  await h.frame();
  await vi.waitFor(() => expect(h.switchObs).toHaveBeenCalledOnce());
  expect((await h.app.inject('/local/v1/demo-test')).json<DemoTestView>()).toMatchObject({
    dataReady: true,
  });
  const clock = vi.spyOn(performance, 'now').mockReturnValue(performance.now() + 30_000);
  expect((await h.app.inject('/local/v1/demo-test')).json<DemoTestView>()).toMatchObject({
    dataReady: false,
  });
  clock.mockRestore();
});

it('keeps background selectors quarantined when marker removal fails after formal restoration', async () => {
  const h = await setup();
  await h.app.inject({
    method: 'POST',
    url: '/operator/local-match/create',
    headers: browser,
    payload: { teamA: 'Retained A', teamB: 'Retained B', format: 'bo1' },
  });
  const formal = (await h.app.inject('/local/v1/match-document')).json<
    ContextEnvelope<MatchDocumentV1>
  >().document;
  await h.runtime.flushSeriesProgressCheckpoint();
  const checkpoint = await readFile(join(h.root, 'series.json'), 'utf8');
  const restore = vi.spyOn(MatchContextController.prototype, 'restoreTemporaryBinding');
  expect((await h.command('begin')).statusCode).toBe(200);
  expect((await h.command('finish')).statusCode).toBe(200);
  const markerPath = join(h.root, 'demo-test.json');
  const marker = await readFile(markerPath, 'utf8');
  await rm(markerPath);
  await mkdir(markerPath);
  expect((await h.command('complete')).statusCode).toBe(409);
  const controller = restore.mock.contexts[0] as MatchContextController;
  const load = vi.fn();
  expect((await controller.stageOnlineMatch('another-match', { kind: 'online', load })).ok).toBe(
    false,
  );
  expect(load).not.toHaveBeenCalled();
  expect(() => controller.activateLocalDocument(formal)).toThrow('demo_test_active');
  expect((await h.app.inject('/local/v1/demo-test')).json<DemoTestView>()).toMatchObject({
    active: true,
  });
  await h.frame();
  expect(h.runtime.getCurrentState().programTelemetry).toBeUndefined();
  await h.runtime.flushSeriesProgressCheckpoint();
  expect(await readFile(join(h.root, 'series.json'), 'utf8')).toBe(checkpoint);
  await rm(markerPath, { recursive: true });
  await writeFile(markerPath, marker);
  expect((await h.command('complete')).statusCode).toBe(200);
  expect(
    (await h.app.inject('/local/v1/match-document')).json<ContextEnvelope<MatchDocumentV1>>()
      .document,
  ).toEqual(formal);
  expect(restore).toHaveBeenCalledOnce();
});
