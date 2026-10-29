import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Fastify from 'fastify';
import type { WebSocketServer as WsServer, WebSocket } from 'ws';
import { createLocalWebOriginPolicy } from '../src/local-web/origin-policy.js';
import { ObsAdapter } from '../src/obs/adapter.js';
import { ObsConfigStore } from '../src/obs/config.js';
import { ObsAudioRouting } from '../src/obs/audio-routing.js';
import { OBS_COLLECTION, obsDesiredScenes } from '../src/obs/desired-state.js';
import { RemoteCommentary } from '../src/obs/remote-commentary.js';
import { registerObsRoutes } from '../src/obs/routes.js';
import type { GameAudioController } from '../src/obs/audio-policy-controller.js';
import type { MusicDirector } from '../src/music/director.js';

const requireFromObs = createRequire(createRequire(import.meta.url).resolve('obs-websocket-js'));
const { WebSocketServer } = requireFromObs('ws') as typeof import('ws');
const { encode, decode } = requireFromObs('@msgpack/msgpack') as {
  encode(value: unknown): Uint8Array;
  decode(value: Uint8Array): unknown;
};

test('HTTP audio mode switches all managed scenes while simulated OBS outputs are active', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mizar-audio-http-'));
  const scenes = obsDesiredScenes('http://127.0.0.1');
  const inputs = [{ inputUuid: 'mic', inputName: 'mic', inputKind: 'wasapi_input_capture' }];
  const items = new Map(
    scenes.map(({ sceneName }) => [
      sceneName,
      [{ sourceUuid: 'mic', sourceName: 'mic', sceneItemId: 1, sceneItemEnabled: true }],
    ]),
  );
  const requests: string[] = [];
  const server: WsServer = new WebSocketServer({
    host: '127.0.0.1',
    port: 0,
    handleProtocols: (protocols) =>
      protocols.has('obswebsocket.msgpack') ? 'obswebsocket.msgpack' : false,
  });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  server.on('connection', (socket: WebSocket) => {
    const send = (value: unknown) => socket.send(encode(value));
    send({ op: 0, d: { obsWebSocketVersion: '5.4.0', rpcVersion: 1 } });
    socket.on('message', (raw) => {
      const message = decode(raw as Uint8Array) as {
        op: number;
        d: { requestType?: string; requestId?: string; requestData?: Record<string, unknown> };
      };
      if (message.op === 1) {
        send({ op: 2, d: { negotiatedRpcVersion: 1 } });
        return;
      }
      if (message.op !== 6) return;
      const type = message.d.requestType!;
      const data = message.d.requestData ?? {};
      requests.push(type);
      let result: Record<string, unknown> = {};
      if (type === 'GetVersion')
        result = {
          availableRequests: [
            'GetInputList',
            'GetInputSettings',
            'GetSceneCollectionList',
            'GetSpecialInputs',
            'GetSceneList',
            'GetSceneItemList',
            'GetGroupSceneItemList',
            'CreateInput',
          ],
        };
      else if (type === 'GetStreamStatus' || type === 'GetRecordStatus')
        result = { outputActive: true };
      else if (type === 'GetSceneCollectionList')
        result = { currentSceneCollectionName: OBS_COLLECTION };
      else if (type === 'GetSpecialInputs') result = {};
      else if (type === 'GetInputList') result = { inputs };
      else if (type === 'GetSceneList')
        result = { scenes: scenes.map(({ sceneName }) => ({ sceneName })) };
      else if (type === 'GetSceneItemList')
        result = { sceneItems: items.get(data.sceneName as string) };
      else if (type === 'GetInputSettings')
        result = { inputKind: 'wasapi_output_capture', inputSettings: { device_id: 'default' } };
      else if (type === 'GetInputDefaultSettings')
        result = { defaultInputSettings: { device_id: 'default' } };
      else if (type === 'GetProfileParameter') result = { parameterValue: 'default' };
      else if (type === 'GetInputAudioMonitorType')
        result = { monitorType: 'OBS_MONITORING_TYPE_NONE' };
      else if (type === 'CreateInput') {
        const input = {
          inputUuid: 'desktop',
          inputName: data.inputName as string,
          inputKind: 'wasapi_output_capture',
        };
        inputs.push(input);
        items.get(data.sceneName as string)!.push({
          sourceUuid: input.inputUuid,
          sourceName: input.inputName,
          sceneItemId: 2,
          sceneItemEnabled: false,
        });
        result = { inputUuid: input.inputUuid, sceneItemId: 2 };
      } else if (type === 'CreateSceneItem') {
        items.get(data.sceneName as string)!.push({
          sourceUuid: 'desktop',
          sourceName: data.sourceName as string,
          sceneItemId: 2,
          sceneItemEnabled: false,
        });
        result = { sceneItemId: 2 };
      } else if (type === 'SetSceneItemEnabled') {
        const item = items
          .get(data.sceneName as string)!
          .find((entry) => entry.sceneItemId === data.sceneItemId)!;
        item.sceneItemEnabled = data.sceneItemEnabled as boolean;
        send({
          op: 5,
          d: {
            eventType: 'SceneItemEnableStateChanged',
            eventIntent: 128,
            eventData: {
              sceneName: data.sceneName,
              sceneItemId: data.sceneItemId,
              sceneItemEnabled: data.sceneItemEnabled,
            },
          },
        });
      } else throw new Error(`Unexpected request ${type}`);
      send({
        op: 7,
        d: {
          requestType: type,
          requestId: message.d.requestId,
          requestStatus: { result: true, code: 100 },
          responseData: result,
        },
      });
    });
  });
  const port = (server.address() as { port: number }).port;
  const config = new ObsConfigStore(join(directory, 'obs.json'));
  await config.save({ executablePath: null, host: '127.0.0.1', port, password: '' });
  const routingPath = join(directory, 'routing.json');
  const revision = randomUUID();
  await writeFile(
    routingPath,
    JSON.stringify({
      revision,
      desktop: null,
      transition: false,
      bindings: {
        game: null,
        remoteCommentary: null,
        microphone: {
          inputUuid: 'mic',
          inputKind: 'wasapi_input_capture',
          endpoint: `ws://127.0.0.1:${port}`,
          collection: OBS_COLLECTION,
        },
      },
    }),
  );
  const routing = new ObsAudioRouting(routingPath);
  const adapter = new ObsAdapter(config, 'http://127.0.0.1', undefined, routing, {
    owner: new RemoteCommentary(join(directory, 'commentary')),
    journal: join(directory, 'probe'),
  });
  const music = {
    store: { state: { monitorPreference: true } },
    async withAudioModeRecovery(run: () => Promise<void>) {
      await run();
    },
    monitorPlanCompatible() {
      return true;
    },
    async prepareDesktopMix(
      _obs: unknown,
      _relation: string,
      apply: (plan: unknown) => Promise<void>,
    ) {
      await apply({
        changes: [],
        managedMusicUuids: [],
        musicBefore: { bgm: null, stinger: null },
        musicAfter: { bgm: null, stinger: null },
      });
    },
    async commitDesktopMonitorOriginals() {},
  } as unknown as MusicDirector;
  const gameAudio = {
    async switchMode<T>(run: () => Promise<T>) {
      return run();
    },
  } as unknown as GameAudioController;
  const app = Fastify();
  registerObsRoutes(app, {
    adapter,
    configStore: config,
    originPolicy: createLocalWebOriginPolicy(),
    activeScene: () => 'waiting',
    gameAudio,
    musicDirector: () => music,
  });
  try {
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const origin = address;
    const response = await fetch(`${address}/operator/obs/audio-mode`, {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({ revision, mode: 'desktop' }),
    });
    assert.equal(response.status, 200, await response.text());
    assert.equal((await routing.desktopBinding())?.inputUuid, 'desktop');
    for (const list of items.values()) {
      assert.equal(list.find((item) => item.sourceUuid === 'desktop')?.sceneItemEnabled, true);
      assert.equal(list.find((item) => item.sourceUuid === 'mic')?.sceneItemEnabled, true);
    }
    assert.equal(
      requests.some((type) => /StopStream|StopRecord/.test(type)),
      false,
    );
  } finally {
    await app.close();
    await adapter.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
