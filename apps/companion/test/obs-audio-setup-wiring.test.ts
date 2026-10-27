import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { obsDesiredScenes, OBS_CAPTURE_INPUT } from '../src/obs/desired-state.js';
import { ObsConfigStore } from '../src/obs/config.js';
import { RemoteCommentary } from '../src/obs/remote-commentary.js';

const fixture = vi.hoisted(() => ({ client: null as FakeObs | null }));
vi.mock('obs-websocket-js', async (original) => {
  const actual = await original<typeof import('obs-websocket-js')>();
  return {
    ...actual,
    OBSWebSocket: class {
      constructor() {
        return fixture.client!;
      }
    },
  };
});
vi.mock('../src/obs/reconcile.js', async (original) => ({
  ...(await original<typeof import('../src/obs/reconcile.js')>()),
  ensureObsConfiguration: () => Promise.resolve([]),
}));
import { ObsAdapter } from '../src/obs/adapter.js';

const base = 'http://127.0.0.1:3000';
class FakeObs extends EventEmitter {
  active = false;
  windows = [
    { itemName: 'TeamSpeak', itemValue: 'TeamSpeak:Qt:ts3client_win64.exe', itemEnabled: true },
  ];
  inputs = new Map<
    string,
    { inputName: string; inputKind: string; inputUuid: string; settings: Record<string, unknown> }
  >();
  scenes = new Map<
    string,
    { sourceName: string; sourceUuid: string; sceneItemId: number; sceneItemEnabled: boolean }[]
  >();
  id = 0;
  constructor() {
    super();
    this.addInput(OBS_CAPTURE_INPUT, 'game_capture', {
      capture_audio: false,
      window: 'Counter-Strike 2:SDL_app:cs2.exe',
    });
    this.addInput('Mizar · Desktop Audio', 'wasapi_output_capture', { device_id: 'default' });
    this.addInput('Mizar · Microphone', 'wasapi_input_capture', { device_id: 'default' });
    for (const scene of obsDesiredScenes(base)) {
      this.addInput(scene.browserInput, 'browser_source', { url: scene.browserUrl });
      this.scenes.set(scene.sceneName, []);
      for (const name of [...scene.sources, 'Mizar · Desktop Audio', 'Mizar · Microphone'])
        this.addItem(scene.sceneName, name, true);
    }
  }
  addInput(name: string, kind: string, settings: Record<string, unknown>) {
    const input = { inputName: name, inputKind: kind, inputUuid: `uuid-${++this.id}`, settings };
    this.inputs.set(name, input);
    return input;
  }
  addItem(scene: string, name: string, enabled: boolean) {
    const item = {
      sourceName: name,
      sourceUuid: this.inputs.get(name)!.inputUuid,
      sceneItemId: ++this.id,
      sceneItemEnabled: enabled,
    };
    this.scenes.get(scene)!.push(item);
    return item;
  }
  async connect() {
    await Promise.resolve();
    return {};
  }
  async disconnect() {
    await Promise.resolve();
    return {};
  }
  async call(type: string, data: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    await Promise.resolve();
    const input = [...this.inputs.values()].find(
      (i) => i.inputUuid === data.inputUuid || i.inputName === data.inputName,
    );
    switch (type) {
      case 'GetSceneCollectionList':
        return { currentSceneCollectionName: 'Mizar' };
      case 'GetStreamStatus':
      case 'GetRecordStatus':
        return { outputActive: this.active };
      case 'GetInputList':
        return { inputs: [...this.inputs.values()] };
      case 'GetSceneList':
        return { scenes: [...this.scenes.keys()].map((sceneName) => ({ sceneName })) };
      case 'GetSceneItemList':
        return { sceneItems: this.scenes.get(String(data.sceneName))!.map((x) => ({ ...x })) };
      case 'GetSpecialInputs':
        return {};
      case 'GetInputSettings':
        return { inputSettings: input!.settings };
      case 'GetInputMute':
        return { inputMuted: false };
      case 'GetInputVolume':
        return { inputVolumeMul: 1 };
      case 'GetInputAudioMonitorType':
        return { monitorType: 'OBS_MONITORING_TYPE_NONE' };
      case 'GetInputAudioTracks':
        return {
          inputAudioTracks: Object.fromEntries([1, 2, 3, 4, 5, 6].map((x) => [String(x), true])),
        };
      case 'GetSourceFilterList':
        return { filters: [] };
      case 'GetVersion':
        return {
          availableRequests: [
            'GetInputList',
            'GetInputSettings',
            'GetInputPropertiesListPropertyItems',
            'CreateInput',
            'GetInputKindList',
          ],
        };
      case 'GetInputKindList':
        return { inputKinds: ['wasapi_process_output_capture'] };
      case 'GetInputPropertiesListPropertyItems':
        return { propertyItems: this.windows };
      case 'CreateInput': {
        const created = this.addInput(
          String(data.inputName),
          String(data.inputKind),
          data.inputSettings as Record<string, unknown>,
        );
        this.addItem(
          String(data.sceneName),
          String(data.inputName),
          Boolean(data.sceneItemEnabled),
        );
        return { inputUuid: created.inputUuid };
      }
      case 'SetInputSettings':
        Object.assign(input!.settings, data.inputSettings as Record<string, unknown>);
        return {};
      case 'CreateSceneItem':
        this.addItem(
          String(data.sceneName),
          String(data.sourceName),
          Boolean(data.sceneItemEnabled),
        );
        return {};
      case 'SetSceneItemEnabled': {
        const item = this.scenes
          .get(String(data.sceneName))!
          .find((x) => x.sceneItemId === data.sceneItemId)!;
        item.sceneItemEnabled = Boolean(data.sceneItemEnabled);
        this.emit('SceneItemEnableStateChanged', {
          sceneName: data.sceneName,
          sceneItemId: data.sceneItemId,
          sceneItemEnabled: data.sceneItemEnabled,
        });
        return {};
      }
      default:
        throw new Error(type);
    }
  }
}

it('configures the default legacy mix through the adapter on its live OBS connection', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mizar-wiring-'));
  try {
    const obs = new FakeObs();
    fixture.client = obs;
    const adapter = new ObsAdapter(
      new ObsConfigStore(join(dir, 'obs.json')),
      base,
      () => {},
      undefined,
      { owner: new RemoteCommentary(join(dir, 'preference')), journal: join(dir, 'probe') },
    );
    expect(await adapter.ensure()).toEqual([]);
    const voice = [...obs.inputs.values()].find(
      (i) => i.settings.window === 'TeamSpeak:Qt:ts3client_win64.exe',
    )!;
    const game = [...obs.inputs.values()].find(
      (i) =>
        i.inputKind === 'wasapi_process_output_capture' &&
        i.settings.window === 'Counter-Strike 2:SDL_app:cs2.exe',
    )!;
    expect(voice).toBeDefined();
    expect(game).toBeDefined();
    for (const items of obs.scenes.values()) {
      expect(
        items.filter((x) => x.sourceUuid === voice.inputUuid && x.sceneItemEnabled),
      ).toHaveLength(1);
      expect(
        items.filter((x) => x.sourceUuid === game.inputUuid && x.sceneItemEnabled),
      ).toHaveLength(1);
      expect(items.find((x) => x.sourceName === 'Mizar · Desktop Audio')!.sceneItemEnabled).toBe(
        false,
      );
      expect(items.find((x) => x.sourceName === 'Mizar · Microphone')!.sceneItemEnabled).toBe(true);
    }
    const inputCount = obs.inputs.size;
    expect(await adapter.ensure()).toEqual([]);
    expect(obs.inputs.size).toBe(inputCount);
    await adapter.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('keeps a custom desktop mix and reports pending without enabling new audio', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mizar-custom-'));
  try {
    const obs = new FakeObs();
    obs.addInput('Custom Audio', 'wasapi_output_capture', { device_id: 'other' });
    fixture.client = obs;
    const adapter = new ObsAdapter(
      new ObsConfigStore(join(dir, 'obs.json')),
      base,
      () => {},
      undefined,
      { owner: new RemoteCommentary(join(dir, 'preference')), journal: join(dir, 'probe') },
    );
    expect((await adapter.ensure()).some((finding) => finding.code === 'commentary_pending')).toBe(
      true,
    );
    for (const items of obs.scenes.values()) {
      expect(
        items.find((item) => item.sourceName === 'Mizar · Desktop Audio')!.sceneItemEnabled,
      ).toBe(true);
      expect(
        items.filter(
          (item) => item.sourceName.includes('Remote Commentary') && item.sceneItemEnabled,
        ),
      ).toHaveLength(0);
    }
    await adapter.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
