import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { ObsAdapter } from '../apps/companion/src/obs/adapter.js';
import { ObsAudioRouting } from '../apps/companion/src/obs/audio-routing.js';
import { ObsConfigStore } from '../apps/companion/src/obs/config.js';
import { OBS_CAPTURE_INPUT, obsDesiredScenes } from '../apps/companion/src/obs/desired-state.js';
import { RemoteCommentary } from '../apps/companion/src/obs/remote-commentary.js';
import { registerObsRoutes } from '../apps/companion/src/obs/routes.js';
import { createLocalWebOriginPolicy } from '../apps/companion/src/local-web/origin-policy.js';
import type {
  MigrationEvent,
  MigrationObserver,
} from '../apps/companion/src/obs/audio-migration.js';
import type { ObsRpc } from '../apps/companion/src/obs/reconcile.js';

const Fastify = createRequire(join(process.cwd(), 'apps/companion/package.json'))('fastify');

const endpoint = 'ws://127.0.0.1:4455';
const base = 'http://127.0.0.1:3000';
const names = obsDesiredScenes(base).map((scene) => scene.sceneName);
type Input = {
  inputName: string;
  inputKind: string;
  inputUuid: string;
  settings: Record<string, unknown>;
};
type Item = {
  sourceName: string;
  sourceUuid: string;
  sceneItemId: number;
  sceneItemEnabled: boolean;
};

export async function audioModeRig(initialMonitor = 'OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT') {
  const dir = await mkdtemp(join(tmpdir(), 'mizar-audio-mode-'));
  const inputs: Input[] = [
    {
      inputName: '桌面声音',
      inputKind: 'wasapi_output_capture',
      inputUuid: 'desktop',
      settings: { device_id: 'default' },
    },
    { inputName: '麦克风', inputKind: 'wasapi_input_capture', inputUuid: 'mic', settings: {} },
    {
      inputName: '其他解说',
      inputKind: 'wasapi_process_output_capture',
      inputUuid: 'ts',
      settings: { window: 'TeamSpeak:Qt:teamspeak.exe' },
    },
    {
      inputName: OBS_CAPTURE_INPUT,
      inputKind: 'game_capture',
      inputUuid: 'video',
      settings: { capture_audio: false },
    },
  ];
  const scenes = new Map<string, Item[]>(
    names.map((name) => [
      name,
      [
        { sourceName: '桌面声音', sourceUuid: 'desktop', sceneItemId: 1, sceneItemEnabled: true },
        { sourceName: '麦克风', sourceUuid: 'mic', sceneItemId: 2, sceneItemEnabled: true },
        {
          sourceName: OBS_CAPTURE_INPUT,
          sourceUuid: 'video',
          sceneItemId: 3,
          sceneItemEnabled: true,
        },
      ],
    ]),
  );
  let nextId = 10;
  let micMonitor = initialMonitor;
  let failNextIndependent = false;
  const violations: string[] = [];
  const writes: { scene: string; source: string; enabled: boolean }[] = [];
  const timeline: string[] = [];
  const listeners = new Set<(event: MigrationEvent) => void>();
  const observer: MigrationObserver = {
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
  const emit = (event: MigrationEvent) => {
    for (const listener of listeners) listener(event);
  };
  const checkDuplicates = () => {
    for (const [name, items] of scenes) {
      const desktop = items.some((item) => item.sourceUuid === 'desktop' && item.sceneItemEnabled);
      const independent = items.some(
        (item) => ['ts', 'game'].includes(item.sourceUuid) && item.sceneItemEnabled,
      );
      if (desktop && independent) violations.push(name);
    }
  };
  const obs: ObsRpc = {
    async call(type, data = {}) {
      if (type === 'GetVersion')
        return {
          availableRequests: [
            'GetInputList',
            'GetInputSettings',
            'GetSceneCollectionList',
            'GetSpecialInputs',
            'GetSceneList',
            'GetSceneItemList',
            'GetGroupSceneItemList',
            'GetInputPropertiesListPropertyItems',
            'CreateInput',
            'GetInputKindList',
          ],
        };
      if (type === 'GetSceneCollectionList') return { currentSceneCollectionName: 'Mizar' };
      if (type === 'GetStreamStatus' || type === 'GetRecordStatus') return { outputActive: false };
      if (type === 'GetSpecialInputs') return {};
      if (type === 'GetSceneList') return { scenes: names.map((sceneName) => ({ sceneName })) };
      if (type === 'GetInputList')
        return {
          inputs: inputs.map(({ inputName, inputUuid, inputKind }) => ({
            inputName,
            inputUuid,
            inputKind,
          })),
        };
      if (type === 'GetInputKindList')
        return {
          inputKinds: [
            'wasapi_process_output_capture',
            'wasapi_input_capture',
            'wasapi_output_capture',
          ],
        };
      if (type === 'GetSceneItemList')
        return { sceneItems: structuredClone(scenes.get(String(data.sceneName))) };
      if (type === 'GetInputPropertiesListPropertyItems')
        return {
          propertyItems: [
            { itemEnabled: true, itemValue: 'TeamSpeak:Qt:teamspeak.exe', itemName: 'TeamSpeak' },
          ],
        };
      if (type === 'GetInputDefaultSettings')
        return { defaultInputSettings: { device_id: 'default', capture_audio: false } };
      if (type === 'GetProfileParameter') return { parameterValue: 'default' };
      if (type === 'GetInputAudioMonitorType') return { monitorType: micMonitor };
      if (type === 'GetInputSettings') {
        const found = inputs.find(
          (input) => input.inputUuid === data.inputUuid || input.inputName === data.inputName,
        );
        if (!found) throw new Error('missing input');
        return { inputSettings: { ...found.settings }, inputKind: found.inputKind };
      }
      if (type === 'CreateInput') {
        const id = data.inputName === '游戏声音' ? 'game' : `created-${nextId++}`;
        const input: Input = {
          inputName: String(data.inputName),
          inputKind: String(data.inputKind),
          inputUuid: id,
          settings: { ...(data.inputSettings as object) },
        };
        inputs.push(input);
        scenes.get(String(data.sceneName))!.push({
          sourceName: input.inputName,
          sourceUuid: id,
          sceneItemId: nextId++,
          sceneItemEnabled: Boolean(data.sceneItemEnabled),
        });
        return { inputUuid: id };
      }
      if (type === 'CreateSceneItem') {
        const input = inputs.find((value) => value.inputName === data.sourceName)!;
        const item = {
          sourceName: input.inputName,
          sourceUuid: input.inputUuid,
          sceneItemId: nextId++,
          sceneItemEnabled: Boolean(data.sceneItemEnabled),
        };
        scenes.get(String(data.sceneName))!.push(item);
        return { sceneItemId: item.sceneItemId };
      }
      if (type === 'SetInputSettings') {
        const input = inputs.find((entry) => entry.inputUuid === data.inputUuid)!;
        Object.assign(input.settings, data.inputSettings);
        emit({
          type: 'inputSettings',
          inputUuid: input.inputUuid,
          settings: { ...input.settings },
        });
        return {};
      }
      if (type === 'SetInputAudioMonitorType') {
        micMonitor = String(data.monitorType);
        timeline.push(`monitor:${micMonitor}`);
        emit({ type: 'monitor', inputUuid: String(data.inputUuid), monitorType: micMonitor });
        return {};
      }
      if (type === 'SetSceneItemEnabled') {
        const item = scenes
          .get(String(data.sceneName))!
          .find((entry) => entry.sceneItemId === data.sceneItemId)!;
        if (failNextIndependent && item.sourceUuid === 'ts' && data.sceneItemEnabled === true) {
          failNextIndependent = false;
          throw new Error('simulated OBS failure');
        }
        item.sceneItemEnabled = Boolean(data.sceneItemEnabled);
        timeline.push(`${item.sourceUuid}:${item.sceneItemEnabled}`);
        writes.push({
          scene: String(data.sceneName),
          source: item.sourceUuid,
          enabled: item.sceneItemEnabled,
        });
        emit({
          type: 'item',
          sceneName: String(data.sceneName),
          sceneItemId: item.sceneItemId,
          enabled: item.sceneItemEnabled,
        });
        checkDuplicates();
        return {};
      }
      throw new Error(`unexpected ${type}`);
    },
  };
  const routing = new ObsAudioRouting(join(dir, 'routing.json'));
  const owner = new RemoteCommentary(join(dir, 'commentary.json'));
  const config = new ObsConfigStore(join(dir, 'obs.json'));
  const adapter = new ObsAdapter(config, base, undefined, routing, {
    owner,
    journal: join(dir, 'journal'),
  });
  Object.assign(adapter, {
    audioConfiguration: {
      run: (fn: (rpc: ObsRpc, ep: string, obsr: MigrationObserver) => unknown) =>
        fn(obs, endpoint, observer),
    },
    withObs: (fn: (rpc: ObsRpc, ep: string) => unknown) => fn(obs, endpoint),
  });
  const empty = { bgm: null, stinger: null };
  const music = {
    store: { state: { monitorPreference: false } },
    withAudioModeRecovery: async (fn: () => Promise<unknown>) => fn(),
    prepareDesktopMix: async (
      _rpc: unknown,
      _rel: unknown,
      fn: (plan: unknown) => Promise<unknown>,
    ) => fn({ changes: [], musicBefore: empty, musicAfter: empty, managedMusicUuids: [] }),
    commitDesktopMonitorOriginals: async () => {},
    monitorPlanCompatible: () => true,
  };
  const app = Fastify();
  registerObsRoutes(app, {
    adapter,
    configStore: config,
    originPolicy: createLocalWebOriginPolicy(),
    activeScene: () => 'waiting',
    preparationValid: () => () => true,
    gameAudio: { switchMode: async (fn: () => Promise<unknown>) => fn() } as never,
    musicDirector: () => music as never,
  });
  const headers = { origin: base, referer: `${base}/`, 'sec-fetch-site': 'same-origin' };
  const request = (method: 'GET' | 'POST', url: string, payload?: unknown) =>
    app.inject({ method, url, headers, ...(payload ? { payload } : {}) });
  return {
    request,
    dir,
    routing,
    adapter,
    music,
    scenes,
    violations,
    writes,
    timeline,
    monitor: () => micMonitor,
    setVideoCapture: (value: boolean) => {
      inputs.find((input) => input.inputUuid === 'video')!.settings.capture_audio = value;
    },
    failIndependent: () => {
      failNextIndependent = true;
    },
    close: async () => {
      await app.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
