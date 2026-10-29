import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { obsDesiredScenes, OBS_CAPTURE_INPUT } from '../src/obs/desired-state.js';
import { ObsConfigStore } from '../src/obs/config.js';
import { RemoteCommentary } from '../src/obs/remote-commentary.js';
import { ObsAudioRouting } from '../src/obs/audio-routing.js';
import { GameAudioController } from '../src/obs/audio-policy-controller.js';
import { EventSubscription } from 'obs-websocket-js';
import Fastify from 'fastify';
import { MusicStore } from '../src/music/store.js';
import { MusicDirector } from '../src/music/director.js';
import { registerMixerRoutes } from '../src/obs/mixer-routes.js';
import type { MixerCommandResult, MixerStatus } from '@mizar/protocol/mixer';
import { musicProgram, musicWav } from './music-fixtures.js';

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
import { ObsAdapter } from '../src/obs/adapter.js';

const base = 'http://127.0.0.1:3000';
class FakeObs extends EventEmitter {
  active = false;
  interruptWrite = false;
  failNextSettings = false;
  failAfterSettings = false;
  manualSettingsDuringWrite = false;
  changeTargetDuringInspection = false;
  settingsWrites = 0;
  onInputSettings?: (input: {
    inputName: string;
    inputKind: string;
    inputUuid: string;
    settings: Record<string, unknown>;
  }) => Promise<void>;
  manualOverride = false;
  subscriptions = 0;
  collection = 'Mizar';
  currentScene = '';
  transforms = new Map<number, Record<string, unknown>>();
  muted = new Map<string, boolean>();
  volumes = new Map<string, number>();
  monitors = new Map<string, string>();
  mediaStates = new Map<string, string>();
  offline = false;
  invalidateOnMuteRead = 0;
  windows = [
    { itemName: 'TeamSpeak', itemValue: 'TeamSpeak:Qt:ts3client_win64.exe', itemEnabled: true },
  ];
  inputs = new Map<
    string,
    { inputName: string; inputKind: string; inputUuid: string; settings: Record<string, unknown> }
  >();
  scenes = new Map<
    string,
    {
      sourceName: string;
      sourceUuid: string;
      sceneItemId: number;
      sceneItemEnabled: boolean;
      sceneItemIndex: number;
    }[]
  >();
  id = 0;
  constructor(empty = false) {
    super();
    if (empty) {
      this.collection = 'Other';
      return;
    }
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
      sceneItemIndex: this.scenes.get(scene)!.length,
    };
    this.scenes.get(scene)!.push(item);
    return item;
  }
  async connect(_endpoint?: string, _password?: string, options?: { eventSubscriptions: number }) {
    await Promise.resolve();
    if (this.offline) throw new Error('offline');
    this.subscriptions = options?.eventSubscriptions ?? EventSubscription.All;
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
        return { currentSceneCollectionName: this.collection, sceneCollections: [this.collection] };
      case 'CreateSceneCollection':
      case 'SetCurrentSceneCollection':
        this.collection = String(data.sceneCollectionName);
        return {};
      case 'CreateScene':
        this.scenes.set(String(data.sceneName), []);
        return {};
      case 'GetSceneTransitionList':
        return {
          transitions: [
            { transitionKind: 'cut_transition', transitionName: 'Cut' },
            { transitionKind: 'fade_transition', transitionName: 'Fade' },
          ],
        };
      case 'GetVideoSettings':
        return {
          baseWidth: 1920,
          baseHeight: 1080,
          outputWidth: 1920,
          outputHeight: 1080,
          fpsNumerator: 60,
          fpsDenominator: 1,
        };
      case 'SetSceneSceneTransitionOverride':
        return {};
      case 'SetCurrentProgramScene':
        this.currentScene = String(data.sceneName);
        return {};
      case 'GetCurrentProgramScene':
        return { currentProgramSceneName: this.currentScene };
      case 'GetCurrentSceneTransitionCursor':
        return { transitionCursor: 1 };
      case 'GetSceneItemTransform':
        return { sceneItemTransform: this.transforms.get(Number(data.sceneItemId)) };
      case 'SetSceneItemTransform':
        this.transforms.set(
          Number(data.sceneItemId),
          data.sceneItemTransform as Record<string, unknown>,
        );
        return {};
      case 'SetSceneItemIndex': {
        const item = this.scenes
          .get(String(data.sceneName))!
          .find((x) => x.sceneItemId === data.sceneItemId)!;
        item.sceneItemIndex = Number(data.sceneItemIndex);
        return {};
      }
      case 'GetStreamStatus':
      case 'GetRecordStatus':
        return { outputActive: this.active };
      case 'GetInputList':
        return { inputs: [...this.inputs.values()] };
      case 'GetSceneList':
        return {
          currentProgramSceneName: this.currentScene,
          scenes: [...this.scenes.keys()].map((sceneName) => ({ sceneName })),
        };
      case 'GetSceneItemList':
        return { sceneItems: this.scenes.get(String(data.sceneName))!.map((x) => ({ ...x })) };
      case 'GetSpecialInputs':
        if (this.changeTargetDuringInspection) {
          const voice = [...this.inputs.values()].find(
            (value) =>
              value.settings.window === 'TeamSpeak:Qt:ts3client_win64.exe' &&
              value.inputKind === 'wasapi_process_output_capture',
          );
          if (voice) {
            this.changeTargetDuringInspection = false;
            this.emit('InputSettingsChanged', {
              inputUuid: voice.inputUuid,
              inputSettings: { ...voice.settings, window: 'Manual:Qt:manual.exe' },
            });
            this.emit('InputSettingsChanged', {
              inputUuid: voice.inputUuid,
              inputSettings: { ...voice.settings },
            });
          }
        }
        return {};
      case 'GetInputSettings':
        if (input && this.onInputSettings) await this.onInputSettings(input);
        return { inputSettings: input!.settings };
      case 'GetInputDefaultSettings':
        return { defaultInputSettings: {} };
      case 'GetInputMute':
        if (this.invalidateOnMuteRead > 0 && --this.invalidateOnMuteRead === 0)
          this.emit('InputRemoved', { inputUuid: data.inputUuid });
        return { inputMuted: this.muted.get(String(data.inputUuid)) ?? false };
      case 'SetInputMute':
        this.muted.set(String(data.inputUuid), Boolean(data.inputMuted));
        this.emit('InputMuteStateChanged', {
          inputUuid: data.inputUuid,
          inputMuted: data.inputMuted,
        });
        return {};
      case 'GetInputVolume':
        return { inputVolumeMul: this.volumes.get(String(data.inputUuid)) ?? 1 };
      case 'SetInputVolume':
        this.volumes.set(String(data.inputUuid), Number(data.inputVolumeMul));
        this.emit('InputVolumeChanged', {
          inputUuid: data.inputUuid,
          inputVolumeMul: data.inputVolumeMul,
        });
        return {};
      case 'GetInputAudioMonitorType':
        return {
          monitorType: this.monitors.get(String(data.inputUuid)) ?? 'OBS_MONITORING_TYPE_NONE',
        };
      case 'SetInputAudioMonitorType':
        this.monitors.set(String(data.inputUuid), String(data.monitorType));
        return {};
      case 'GetMediaInputStatus':
        return {
          mediaState: this.mediaStates.get(String(data.inputUuid)) ?? 'OBS_MEDIA_STATE_STOPPED',
          mediaCursor: 0,
          mediaDuration: 10000,
        };
      case 'TriggerMediaInputAction':
        this.mediaStates.set(
          String(data.inputUuid),
          data.mediaAction === 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART'
            ? 'OBS_MEDIA_STATE_PLAYING'
            : 'OBS_MEDIA_STATE_STOPPED',
        );
        return {};
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
            'GetSceneCollectionList',
            'GetSpecialInputs',
            'GetSceneList',
            'GetSceneItemList',
            'GetGroupSceneItemList',
            'GetInputVolume',
            'SetInputVolume',
            'GetInputMute',
            'SetInputMute',
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
        this.settingsWrites++;
        if (this.failNextSettings) {
          this.failNextSettings = false;
          throw new Error('settings_write_failed');
        }
        Object.assign(input!.settings, data.inputSettings as Record<string, unknown>);
        this.emit('InputSettingsChanged', {
          inputUuid: input!.inputUuid,
          inputSettings: { ...input!.settings },
        });
        if (this.manualSettingsDuringWrite) {
          this.manualSettingsDuringWrite = false;
          this.emit('InputSettingsChanged', {
            inputUuid: input!.inputUuid,
            inputSettings: { ...input!.settings, window: 'Manual:Qt:manual.exe' },
          });
          this.emit('InputSettingsChanged', {
            inputUuid: input!.inputUuid,
            inputSettings: { ...input!.settings },
          });
        }
        if (this.failAfterSettings) {
          this.failAfterSettings = false;
          throw new Error('settings_receipt_lost');
        }
        return {};
      case 'CreateSceneItem': {
        const item = this.addItem(
          String(data.sceneName),
          typeof data.sourceName === 'string'
            ? data.sourceName
            : [...this.inputs.values()].find((item) => item.inputUuid === data.sourceUuid)!
                .inputName,
          Boolean(data.sceneItemEnabled),
        );
        return { sceneItemId: item.sceneItemId };
      }
      case 'SetSceneItemEnabled': {
        const item = this.scenes
          .get(String(data.sceneName))!
          .find((x) => x.sceneItemId === data.sceneItemId)!;
        item.sceneItemEnabled = Boolean(data.sceneItemEnabled);
        const event = {
          sceneName: data.sceneName,
          sceneItemId: data.sceneItemId,
          sceneItemEnabled: data.sceneItemEnabled,
        };
        if (this.subscriptions & EventSubscription.SceneItems) {
          this.emit('SceneItemEnableStateChanged', event);
          if (this.manualOverride) {
            this.manualOverride = false;
            this.emit('SceneItemEnableStateChanged', { ...event, sceneItemEnabled: false });
            this.emit('SceneItemEnableStateChanged', { ...event, sceneItemEnabled: true });
          }
        }
        if (this.interruptWrite) {
          this.interruptWrite = false;
          this.emit('StreamStateChanged', { outputActive: true });
        }
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

it('ignores unrelated custom inputs while migrating managed audio', async () => {
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
    expect(await adapter.ensure()).toEqual([]);
    expect(obs.inputs.get('Custom Audio')!.settings).toEqual({ device_id: 'other' });
    for (const items of obs.scenes.values()) {
      expect(
        items.find((item) => item.sourceName === 'Mizar · Desktop Audio')!.sceneItemEnabled,
      ).toBe(false);
      expect(
        items.filter(
          (item) => item.sourceName.includes('Remote Commentary') && item.sceneItemEnabled,
        ),
      ).toHaveLength(1);
    }
    await adapter.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('manages custom direct audio, reuses the existing microphone and preserves unrelated scenes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mizar-custom-managed-'));
  try {
    const obs = new FakeObs();
    const custom = obs.addInput('My Game', 'wasapi_output_capture', { device_id: 'sonar-game' });
    const music = obs.addInput(
      'Mizar · BGM · 00000000-0000-4000-8000-000000000001',
      'ffmpeg_source',
      { local_file: 'music.mp3' },
    );
    const mic = obs.addInput('My Microphone', 'wasapi_input_capture', { device_id: 'my-mic' });
    for (const scene of obsDesiredScenes(base)) {
      obs.addItem(scene.sceneName, custom.inputName, true);
      obs.addItem(scene.sceneName, music.inputName, true);
      obs.addItem(scene.sceneName, mic.inputName, true);
    }
    obs.scenes.set('Personal', []);
    obs.addItem('Personal', custom.inputName, true);
    const personal = structuredClone(obs.scenes.get('Personal'));
    fixture.client = obs;
    const routing = new ObsAudioRouting(join(dir, 'routing'));
    const adapter = new ObsAdapter(
      new ObsConfigStore(join(dir, 'obs.json')),
      base,
      () => {},
      routing,
      { owner: new RemoteCommentary(join(dir, 'preference')), journal: join(dir, 'probe') },
    );
    expect(await adapter.ensure()).toEqual([]);
    expect((await routing.commentaryBinding()).microphone?.inputUuid).toBe(mic.inputUuid);
    expect(obs.scenes.get('Personal')).toEqual(personal);
    expect(custom.settings).toEqual({ device_id: 'sonar-game' });
    expect(mic.settings).toEqual({ device_id: 'my-mic' });
    const status = await adapter.readAudioRouting();
    await adapter.bindAudio({
      role: 'game',
      selectionId: status.candidates.find((input) => input.uuid === custom.inputUuid)!.selectionId,
      revision: status.revision,
    });
    // The selected hardware route is now applied in every managed scene, without manual OBS edits.
    expect(await adapter.ensure()).toEqual([]);
    for (const scene of obsDesiredScenes(base)) {
      const active = obs.scenes.get(scene.sceneName)!.filter((item) => item.sceneItemEnabled);
      expect(active.filter((item) => item.sourceUuid === custom.inputUuid)).toHaveLength(1);
      expect(active.filter((item) => item.sourceUuid === mic.inputUuid)).toHaveLength(1);
      expect(active.filter((item) => item.sourceUuid === music.inputUuid)).toHaveLength(1);
      expect(
        active.some(
          (item) =>
            item.sourceName === 'Mizar · Desktop Audio' ||
            item.sourceName.startsWith('Mizar · Game Audio '),
        ),
      ).toBe(false);
    }
    const backups = (await readdir(dir)).filter((name) => name.includes('.migration.completed-'));
    expect(backups).toHaveLength(2);
    const saved = JSON.parse(await readFile(join(dir, backups[0]!), 'utf8')) as {
      fields: unknown[];
    };
    expect(saved.fields.length).toBeGreaterThan(0);
    expect(await adapter.ensure()).toEqual([]);
    expect(
      (await readdir(dir)).filter((name) => name.includes('.migration.completed-')),
    ).toHaveLength(2);
    expect(obs.scenes.get('Personal')).toEqual(personal);
    await adapter.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('creates scenes and audio through the real configure owner and seeds game policy binding', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mizar-complete-'));
  try {
    const obs = new FakeObs(true);
    fixture.client = obs;
    const routing = new ObsAudioRouting(join(dir, 'routing'));
    const config = new ObsConfigStore(join(dir, 'obs.json'));
    const adapter = new ObsAdapter(config, base, () => {}, routing, {
      owner: new RemoteCommentary(join(dir, 'preference')),
      journal: join(dir, 'probe'),
    });
    expect(await adapter.ensure()).toEqual([]);
    const game = [...obs.inputs.values()].find(
      (x) =>
        x.inputKind === 'wasapi_process_output_capture' &&
        x.settings.window === 'Counter-Strike 2:SDL_app:cs2.exe',
    )!;
    expect((await routing.gameBinding()).binding?.inputUuid).toBe(game.inputUuid);
    for (const items of obs.scenes.values()) {
      expect(
        items.filter((item) => item.sourceUuid === game.inputUuid && item.sceneItemEnabled),
      ).toHaveLength(1);
      expect(
        items.find((item) => item.sourceName === 'Mizar · Desktop Audio')!.sceneItemEnabled,
      ).toBe(false);
    }
    const controller = new GameAudioController(routing, config, join(dir, 'policy'));
    await controller.load();
    await controller.configure({ mode: 'mute' }, controller.status().revision);
    controller.tick('halftime');
    await vi.waitFor(() => expect(obs.muted.get(game.inputUuid)).toBe(true));
    controller.tick('gameplay');
    await vi.waitFor(() => expect(obs.muted.get(game.inputUuid)).toBe(false));
    controller.close();
    const routingStatus = await adapter.readAudioRouting();
    await adapter.bindAudio({ role: 'game', selectionId: null, revision: routingStatus.revision });
    expect(await adapter.ensure()).toEqual([]);
    expect((await routing.gameBinding()).binding).toBeNull();
    expect((await new ObsAudioRouting(join(dir, 'routing')).gameBinding()).binding).toBeNull();
    await adapter.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('enables technical music monitoring through the scenes created by the real setup', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mizar-music-setup-'));
  try {
    const obs = new FakeObs(true);
    fixture.client = obs;
    const routing = new ObsAudioRouting(join(dir, 'routing'));
    const adapter = new ObsAdapter(
      new ObsConfigStore(join(dir, 'obs.json')),
      base,
      () => {},
      routing,
      {
        owner: new RemoteCommentary(join(dir, 'preference')),
        journal: join(dir, 'probe'),
      },
    );
    expect(await adapter.ensure()).toEqual([]);
    const capture = obs.inputs.get(OBS_CAPTURE_INPUT)!;
    expect(capture.settings.capture_audio).toBe(false);
    const store = new MusicStore(join(dir, 'music'));
    await store.load();
    const options = { owner: store.state.owner, sources: store.state.sources, baseUrl: base };
    expect(await routing.musicMonitorSafe(obs, 'ws://127.0.0.1:4455', options)).toBe(true);
    capture.settings.capture_audio = true;
    expect(await routing.musicMonitorSafe(obs, 'ws://127.0.0.1:4455', options)).toBe(false);
    delete capture.settings.capture_audio;
    expect(await routing.musicMonitorSafe(obs, 'ws://127.0.0.1:4455', options)).toBe(false);
    capture.settings.capture_audio = false;
    const track = await store.add('合成.wav', musicWav());
    const config = structuredClone(store.state.config);
    config.groups.technical.tracks = [track];
    config.groups.technical.fadeInMs = 0;
    await store.configure(config);
    const program = musicProgram();
    program.status = { context: 'fresh', telemetry: 'fresh', identity: 'matched' };
    program.series!.bindingState = 'bound';
    program.map.phase = 'live';
    program.map.roundNumber = 5;
    program.clock = { phase: 'paused', endsInSeconds: 40 };
    let sessionError: unknown;
    const director = new MusicDirector(
      store,
      {
        session: (run) =>
          run(obs, 1).catch((error: unknown) => {
            sessionError = error;
            throw error;
          }),
        close: () => Promise.resolve(),
      },
      () => ({ program, active: 'gameplay', production: true }),
      Date.now,
      Math.random,
      () =>
        routing.musicMonitorSafe(obs, 'ws://127.0.0.1:4455', {
          ...options,
          sources: store.state.sources,
        }),
    );
    await director.tick();
    expect(sessionError).toBeUndefined();
    expect(director.get()).toMatchObject({ connection: 'connected', bgm: { group: 'technical' } });
    expect(director.get().playback).toBe('playing');
    expect(director.get().monitor).toBe('enabled');
    expect(obs.monitors.get(store.state.sources.bgm!)).toBe(
      'OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT',
    );
    await director.close();
    await adapter.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('reads and writes the mixer through the real adapter and rejects stale bindings', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mizar-mixer-wiring-'));
  const app = Fastify();
  try {
    const obs = new FakeObs(true);
    fixture.client = obs;
    const routing = new ObsAudioRouting(join(dir, 'routing'));
    const config = new ObsConfigStore(join(dir, 'obs.json'));
    const adapter = new ObsAdapter(config, base, () => {}, routing, {
      owner: new RemoteCommentary(join(dir, 'preference')),
      journal: join(dir, 'probe'),
    });
    await adapter.ensure();
    const game = new GameAudioController(routing, config, join(dir, 'policy'));
    await game.load();
    await game.configure({ mode: 'mute' }, game.status().revision);
    game.tick('halftime');
    await vi.waitFor(() => expect(game.status().ownership).toBe('owned'));
    const store = new MusicStore(join(dir, 'music'));
    await store.load();
    const director = new MusicDirector(
      store,
      { session: () => Promise.reject(new Error('unused')), close: async () => {} },
      () => ({ program: musicProgram(), active: 'waiting', production: false }),
    );
    registerMixerRoutes(app, adapter, director, game, {
      mode: 'loopback',
      bindHost: '127.0.0.1',
      allowedOrigins: [],
    });
    const read = async (): Promise<MixerStatus> =>
      (await app.inject({ method: 'GET', url: '/local/v1/mixer' })).json<MixerStatus>();
    const initial = await read();
    expect(initial.channels.music.volume).toBe(1);
    const musicWrite = await app.inject({
      method: 'POST',
      url: '/operator/mixer',
      headers: { origin: base },
      payload: { revision: initial.revision, channel: 'music', volume: 0.4, muted: true },
    });
    expect(musicWrite.json<MixerCommandResult>().status).toBe('confirmed');
    expect((await read()).channels.music).toMatchObject({ volume: 0.4, muted: true });
    for (const channel of ['game', 'remoteCommentary', 'microphone'] as const) {
      expect(initial.channels[channel].control).toBe('available');
      const result = await app.inject({
        method: 'POST',
        url: '/operator/mixer',
        headers: { origin: base },
        payload: { revision: initial.revision, channel, volume: 0.35, muted: channel !== 'game' },
      });
      expect(result.json<MixerCommandResult>().status).toBe('confirmed');
      const after = await read();
      expect(after.channels[channel].volume).toBeCloseTo(0.35);
      expect(after.channels[channel].muted).toBe(channel !== 'game');
    }
    game.tick('gameplay');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await read()).channels.game.muted).toBe(false);
    obs.invalidateOnMuteRead = 9; // Three roles in each of initial, pre-write and final reads.
    const invalidated = await app.inject({
      method: 'POST',
      url: '/operator/mixer',
      headers: { origin: base },
      payload: { revision: initial.revision, channel: 'microphone', volume: 0.6 },
    });
    expect(invalidated.json<MixerCommandResult>().status).toBe('unknown');
    const routingStatus = await adapter.readAudioRouting();
    await adapter.bindAudio({
      role: 'microphone',
      selectionId: null,
      revision: routingStatus.revision,
    });
    const stale = await app.inject({
      method: 'POST',
      url: '/operator/mixer',
      headers: { origin: base },
      payload: { revision: initial.revision, channel: 'microphone', volume: 0.9 },
    });
    expect(stale.json<MixerCommandResult>().status).toBe('rejected');
    obs.offline = true;
    expect((await read()).channels.game.control).toBe('unknown');
    const disconnected = await app.inject({
      method: 'POST',
      url: '/operator/mixer',
      headers: { origin: base },
      payload: { revision: initial.revision, channel: 'game', volume: 0.1 },
    });
    expect(disconnected.json<MixerCommandResult>().status).toBe('unknown');
    game.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await adapter.close();
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

it('resumes a waiting TS setup and preserves a manual cancellation', async () => {
  for (const cancel of [false, true]) {
    const dir = await mkdtemp(join(tmpdir(), 'mizar-wait-wiring-'));
    try {
      const obs = new FakeObs(true);
      obs.windows = [];
      fixture.client = obs;
      const owner = new RemoteCommentary(join(dir, 'preference'));
      const routing = new ObsAudioRouting(join(dir, 'routing'));
      const adapter = new ObsAdapter(
        new ObsConfigStore(join(dir, 'obs.json')),
        base,
        () => {},
        routing,
        { owner, journal: join(dir, 'probe') },
      );
      expect(
        (await adapter.ensure()).some((finding) => finding.code === 'commentary_pending'),
      ).toBe(true);
      const probe = [...obs.inputs.values()].find(
        (x) => x.inputKind === 'wasapi_process_output_capture',
      )!;
      if (cancel) await adapter.setCommentaryMode('disabled', (await owner.get()).revision);
      obs.windows = [
        { itemName: 'TeamSpeak', itemValue: 'TeamSpeak:Qt:ts3client_win64.exe', itemEnabled: true },
      ];
      adapter.startCommentaryRecovery();
      if (!cancel) {
        await vi.waitFor(async () => expect((await routing.gameBinding()).binding).not.toBeNull());
        expect(probe.settings.window).toBe('TeamSpeak:Qt:ts3client_win64.exe');
        for (const items of obs.scenes.values()) {
          expect(items.find((item) => item.sourceUuid === probe.inputUuid)!.sceneItemEnabled).toBe(
            true,
          );
          expect(
            items.find((item) => item.sourceName === 'Mizar · Desktop Audio')!.sceneItemEnabled,
          ).toBe(false);
        }
      } else {
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(probe.settings.window).toBeUndefined();
        expect((await routing.gameBinding()).binding).toBeNull();
        for (const items of obs.scenes.values())
          expect(
            items.find((item) => item.sourceName === 'Mizar · Desktop Audio')!.sceneItemEnabled,
          ).toBe(true);
      }
      await adapter.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

it('retries a confirmed rollback using the owned inert game source', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mizar-rollback-wiring-'));
  try {
    const obs = new FakeObs();
    obs.interruptWrite = true;
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
    for (const items of obs.scenes.values())
      expect(
        items.find((item) => item.sourceName === 'Mizar · Desktop Audio')!.sceneItemEnabled,
      ).toBe(true);
    expect(await adapter.ensure()).toEqual([]);
    for (const items of obs.scenes.values())
      expect(
        items.find((item) => item.sourceName === 'Mizar · Desktop Audio')!.sceneItemEnabled,
      ).toBe(false);
    await adapter.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('keeps the journal and yields when a user changes a migrated item away and back', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mizar-manual-wiring-'));
  try {
    const obs = new FakeObs();
    obs.manualOverride = true;
    fixture.client = obs;
    const journal = join(dir, 'probe');
    const adapter = new ObsAdapter(
      new ObsConfigStore(join(dir, 'obs.json')),
      base,
      () => {},
      undefined,
      { owner: new RemoteCommentary(join(dir, 'preference')), journal },
    );
    expect((await adapter.ensure()).some((finding) => finding.code === 'commentary_pending')).toBe(
      true,
    );
    const { AudioMigration } = await import('../src/obs/audio-migration.js');
    const pending = await new AudioMigration(`${journal}.migration`).pending();
    expect(pending?.fields.some((field) => field.externalChanged)).toBe(true);
    const changed = pending!.fields.find((field) => field.externalChanged)!;
    expect(
      obs.scenes.get(changed.sceneName)!.find((item) => item.sceneItemId === changed.sceneItemId)!
        .sceneItemEnabled,
    ).toBe(true);
    for (const items of obs.scenes.values())
      expect(
        items.find((item) => item.sourceName === 'Mizar · Desktop Audio')!.sceneItemEnabled,
      ).toBe(true);
    await adapter.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('resumes waiting TS after the companion restarts with the persisted default intent', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mizar-wait-restart-'));
  try {
    const obs = new FakeObs(true);
    obs.windows = [];
    fixture.client = obs;
    const preference = join(dir, 'preference');
    const journal = join(dir, 'probe');
    const routingPath = join(dir, 'routing');
    const firstOwner = new RemoteCommentary(preference);
    const first = new ObsAdapter(
      new ObsConfigStore(join(dir, 'obs.json')),
      base,
      () => {},
      new ObsAudioRouting(routingPath),
      { owner: firstOwner, journal },
    );
    expect((await first.ensure()).some((finding) => finding.code === 'commentary_pending')).toBe(
      true,
    );
    const revision = (await firstOwner.get()).revision;
    await first.close();
    const nextOwner = new RemoteCommentary(preference);
    expect((await nextOwner.get()).revision).toBe(revision);
    const routing = new ObsAudioRouting(routingPath);
    const next = new ObsAdapter(
      new ObsConfigStore(join(dir, 'obs.json')),
      base,
      () => {},
      routing,
      { owner: nextOwner, journal },
    );
    obs.windows = [
      { itemName: 'TeamSpeak', itemValue: 'TeamSpeak:Qt:ts3client_win64.exe', itemEnabled: true },
    ];
    next.startCommentaryRecovery();
    await vi.waitFor(async () => expect((await routing.gameBinding()).binding).not.toBeNull());
    for (const items of obs.scenes.values())
      expect(
        items.find((item) => item.sourceName === 'Mizar · Desktop Audio')!.sceneItemEnabled,
      ).toBe(false);
    await next.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('does not migrate a desktop source explicitly bound by the user', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mizar-bound-desktop-'));
  try {
    const obs = new FakeObs();
    fixture.client = obs;
    const routing = new ObsAudioRouting(join(dir, 'routing'));
    const adapter = new ObsAdapter(
      new ObsConfigStore(join(dir, 'obs.json')),
      base,
      () => {},
      routing,
      { owner: new RemoteCommentary(join(dir, 'preference')), journal: join(dir, 'probe') },
    );
    const status = await adapter.readAudioRouting();
    const desktop = status.candidates.find(
      (candidate) => candidate.name === 'Mizar · Desktop Audio',
    )!;
    await adapter.bindAudio({
      role: 'game',
      selectionId: desktop.selectionId,
      revision: status.revision,
    });
    expect((await adapter.ensure()).some((finding) => finding.code === 'commentary_pending')).toBe(
      true,
    );
    expect((await routing.gameBinding()).binding?.inputUuid).toBe(desktop.uuid);
    for (const items of obs.scenes.values())
      expect(
        items.find((item) => item.sourceName === 'Mizar · Desktop Audio')!.sceneItemEnabled,
      ).toBe(true);
    await adapter.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('cancels waiting discovery when an operator selects an existing source', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mizar-wait-override-'));
  try {
    const obs = new FakeObs(true);
    obs.windows = [];
    fixture.client = obs;
    const owner = new RemoteCommentary(join(dir, 'preference'));
    const routing = new ObsAudioRouting(join(dir, 'routing'));
    const adapter = new ObsAdapter(
      new ObsConfigStore(join(dir, 'obs.json')),
      base,
      () => {},
      routing,
      { owner, journal: join(dir, 'probe') },
    );
    expect((await adapter.ensure()).some((item) => item.code === 'commentary_pending')).toBe(true);
    const probe = [...obs.inputs.values()].find(
      (item) => item.inputKind === 'wasapi_process_output_capture',
    )!;
    const selected = obs.addInput('Manual voice', 'wasapi_process_output_capture', {
      window: 'Other:Qt:voice.exe',
    });
    const status = await adapter.readAudioRouting();
    await adapter.bindAudio({
      role: 'remoteCommentary',
      selectionId: status.candidates.find((item) => item.uuid === selected.inputUuid)!.selectionId,
      revision: status.revision,
    });
    obs.windows = [
      { itemName: 'TeamSpeak', itemValue: 'TeamSpeak:Qt:ts3client_win64.exe', itemEnabled: true },
    ];
    adapter.startCommentaryRecovery();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(probe.settings.window).toBeUndefined();
    expect((await owner.get()).preference).toMatchObject({
      mode: 'existingInput',
      binding: { inputUuid: selected.inputUuid },
    });
    expect((await new RemoteCommentary(join(dir, 'preference')).get()).preference).toMatchObject({
      mode: 'existingInput',
      binding: { inputUuid: selected.inputUuid },
    });
    await adapter.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('persists an application choice and waits for it to return before migrating', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mizar-app-choice-'));
  try {
    const obs = new FakeObs();
    obs.windows = [{ itemName: 'Voice App', itemValue: 'Voice:Qt:voice.exe', itemEnabled: true }];
    fixture.client = obs;
    const preference = join(dir, 'preference');
    const routing = new ObsAudioRouting(join(dir, 'routing'));
    const owner = new RemoteCommentary(preference);
    const adapter = new ObsAdapter(
      new ObsConfigStore(join(dir, 'obs.json')),
      base,
      () => {},
      routing,
      { owner, journal: join(dir, 'probe') },
    );
    const choices = await adapter.listCommentaryApplications();
    expect(choices.candidates.map((candidate) => candidate.label)).toEqual(['Voice App']);
    await adapter.selectCommentaryApplication(choices.candidates[0]!.id, choices.revision);
    expect((await new RemoteCommentary(preference).get()).preference).toEqual({
      mode: 'application',
      window: 'Voice:Qt:voice.exe',
    });
    obs.windows = [];
    expect(
      (await adapter.ensure()).some((finding) => finding.message.includes('等待所选应用启动')),
    ).toBe(true);
    for (const items of obs.scenes.values())
      expect(
        items.find((item) => item.sourceName === 'Mizar · Desktop Audio')!.sceneItemEnabled,
      ).toBe(true);
    obs.windows = [{ itemName: 'Voice App', itemValue: 'Voice:Qt:voice.exe', itemEnabled: true }];
    adapter.startCommentaryRecovery();
    await vi.waitFor(async () => expect((await routing.gameBinding()).binding).not.toBeNull());
    const voice = [...obs.inputs.values()].find(
      (item) => item.settings.window === 'Voice:Qt:voice.exe',
    )!;
    expect(voice).toBeDefined();
    expect((await owner.get()).preference.mode).toBe('application');
    for (const items of obs.scenes.values())
      expect(items.find((item) => item.sourceUuid === voice.inputUuid)!.sceneItemEnabled).toBe(
        true,
      );
    await adapter.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('replaces a waiting application intent or explicitly restores TS before migration', async () => {
  for (const auto of [false, true]) {
    const dir = await mkdtemp(join(tmpdir(), 'mizar-app-reselect-'));
    try {
      const obs = new FakeObs();
      fixture.client = obs;
      obs.windows = [{ itemName: 'Voice One', itemValue: 'Voice:Qt:one.exe', itemEnabled: true }];
      const owner = new RemoteCommentary(join(dir, 'preference'));
      const adapter = new ObsAdapter(
        new ObsConfigStore(join(dir, 'obs.json')),
        base,
        () => {},
        undefined,
        { owner, journal: join(dir, 'probe') },
      );
      const first = await adapter.listCommentaryApplications();
      await adapter.selectCommentaryApplication(first.candidates[0]!.id, first.revision);
      obs.windows = [];
      expect((await adapter.ensure()).some((item) => item.code === 'commentary_pending')).toBe(
        true,
      );
      obs.windows = auto
        ? [
            {
              itemName: 'TeamSpeak',
              itemValue: 'TeamSpeak:Qt:ts3client_win64.exe',
              itemEnabled: true,
            },
          ]
        : [{ itemName: 'Voice Two', itemValue: 'Voice:Qt:two.exe', itemEnabled: true }];
      if (auto) await adapter.setCommentaryMode('autoTeamspeak', (await owner.get()).revision);
      else {
        const second = await adapter.listCommentaryApplications();
        await adapter.selectCommentaryApplication(second.candidates[0]!.id, second.revision);
      }
      expect(await adapter.ensure()).toEqual([]);
      const wanted = auto ? 'TeamSpeak:Qt:ts3client_win64.exe' : 'Voice:Qt:two.exe';
      const voice = [...obs.inputs.values()].find((item) => item.settings.window === wanted);
      expect(voice).toBeDefined();
      for (const items of obs.scenes.values())
        expect(items.find((item) => item.sourceUuid === voice!.inputUuid)!.sceneItemEnabled).toBe(
          true,
        );
      await adapter.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

it('preserves the compact BP guard before preparing any audio', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mizar-bp-audio-'));
  try {
    const obs = new FakeObs();
    fixture.client = obs;
    const { BP_COMPACT_INPUT } = await import('../src/obs/bp-overlay.js');
    obs.addInput(BP_COMPACT_INPUT, 'browser_source', {});
    const gameplay = obsDesiredScenes(base).find((scene) => scene.id === 'gameplay')!;
    obs.addItem(gameplay.sceneName, BP_COMPACT_INPUT, true);
    const adapter = new ObsAdapter(
      new ObsConfigStore(join(dir, 'obs.json')),
      base,
      () => {},
      undefined,
      { owner: new RemoteCommentary(join(dir, 'preference')), journal: join(dir, 'probe') },
    );
    await expect(adapter.ensure()).rejects.toThrow('紧凑 BP');
    expect(
      [...obs.inputs.values()].some((input) => input.inputKind === 'wasapi_process_output_capture'),
    ).toBe(false);
    await adapter.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('accepts an owned disabled compact BP source before and after audio migration', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mizar-bp-disabled-audio-'));
  try {
    const obs = new FakeObs();
    fixture.client = obs;
    const { BP_COMPACT_INPUT, BP_COMPACT_PATH } = await import('../src/obs/bp-overlay.js');
    obs.addInput(BP_COMPACT_INPUT, 'browser_source', {
      url: new URL(BP_COMPACT_PATH, base).toString(),
      width: 1920,
      height: 1080,
    });
    const gameplay = obsDesiredScenes(base).find((scene) => scene.id === 'gameplay')!;
    const compact = obs.addItem(gameplay.sceneName, BP_COMPACT_INPUT, false);
    const adapter = new ObsAdapter(
      new ObsConfigStore(join(dir, 'obs.json')),
      base,
      () => {},
      undefined,
      { owner: new RemoteCommentary(join(dir, 'preference')), journal: join(dir, 'probe') },
    );
    expect(await adapter.ensure()).toEqual([]);
    expect(await adapter.ensure()).toEqual([]);
    expect(compact.sceneItemEnabled).toBe(false);
    for (const items of obs.scenes.values())
      expect(
        items.find((item) => item.sourceName === 'Mizar · Desktop Audio')!.sceneItemEnabled,
      ).toBe(false);
    await adapter.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('rejects a modified compact BP source without migrating desktop audio', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mizar-bp-modified-audio-'));
  try {
    const obs = new FakeObs();
    fixture.client = obs;
    const { BP_COMPACT_INPUT } = await import('../src/obs/bp-overlay.js');
    obs.addInput(BP_COMPACT_INPUT, 'browser_source', {
      url: 'https://example.com/',
      width: 1920,
      height: 1080,
    });
    const gameplay = obsDesiredScenes(base).find((scene) => scene.id === 'gameplay')!;
    obs.addItem(gameplay.sceneName, BP_COMPACT_INPUT, false);
    const adapter = new ObsAdapter(
      new ObsConfigStore(join(dir, 'obs.json')),
      base,
      () => {},
      undefined,
      { owner: new RemoteCommentary(join(dir, 'preference')), journal: join(dir, 'probe') },
    );
    expect((await adapter.ensure()).some((item) => item.code === 'commentary_pending')).toBe(true);
    for (const items of obs.scenes.values())
      expect(
        items.find((item) => item.sourceName === 'Mizar · Desktop Audio')!.sceneItemEnabled,
      ).toBe(true);
    await adapter.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('switches the owned source from TS to an application and then to another application', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mizar-owned-switch-'));
  try {
    const obs = new FakeObs();
    fixture.client = obs;
    const owner = new RemoteCommentary(join(dir, 'preference'));
    const routing = new ObsAudioRouting(join(dir, 'routing'));
    const adapter = new ObsAdapter(
      new ObsConfigStore(join(dir, 'obs.json')),
      base,
      () => {},
      routing,
      { owner, journal: join(dir, 'probe') },
    );
    expect(await adapter.ensure()).toEqual([]);
    const voice = [...obs.inputs.values()].find(
      (input) => input.settings.window === 'TeamSpeak:Qt:ts3client_win64.exe',
    )!;
    for (const [name, window] of [
      ['Discord', 'Discord:Qt:discord.exe'],
      ['Other', 'Other:Qt:other.exe'],
    ]) {
      obs.windows = [{ itemName: name!, itemValue: window!, itemEnabled: true }];
      const choices = await adapter.listCommentaryApplications();
      await adapter.selectCommentaryApplication(choices.candidates[0]!.id, choices.revision);
      expect(await adapter.ensure()).toEqual([]);
      expect(voice.settings.window).toBe(window);
      for (const items of obs.scenes.values())
        expect(
          items.filter((item) => item.sourceUuid === voice.inputUuid && item.sceneItemEnabled),
        ).toHaveLength(1);
    }
    obs.windows = [];
    await adapter.setCommentaryMode('autoTeamspeak', (await owner.get()).revision);
    expect((await adapter.ensure()).some((finding) => finding.code === 'commentary_pending')).toBe(
      true,
    );
    expect(voice.settings.window).toBe('Other:Qt:other.exe');
    obs.windows = [
      { itemName: 'TeamSpeak', itemValue: 'TeamSpeak:Qt:ts3client_win64.exe', itemEnabled: true },
    ];
    const recoveryEnsure = vi.spyOn(adapter, 'ensure');
    adapter.startCommentaryRecovery();
    await vi.waitFor(() => expect(recoveryEnsure).toHaveBeenCalled());
    expect(await recoveryEnsure.mock.results[0]!.value).toEqual([]);
    expect(await adapter.ensure()).toEqual([]);
    expect(voice.settings.window).toBe('TeamSpeak:Qt:ts3client_win64.exe');
    await adapter.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('defers during output and yields to changed targets or uncertain writes', async () => {
  for (const scenario of [
    'output',
    'manual',
    'manualTarget',
    'failure',
    'uncertain',
    'concurrent',
    'routing',
  ]) {
    const dir = await mkdtemp(join(tmpdir(), 'mizar-owned-switch-guard-'));
    try {
      const obs = new FakeObs();
      fixture.client = obs;
      const owner = new RemoteCommentary(join(dir, 'preference'));
      const adapter = new ObsAdapter(
        new ObsConfigStore(join(dir, 'obs.json')),
        base,
        () => {},
        new ObsAudioRouting(join(dir, 'routing')),
        { owner, journal: join(dir, 'probe') },
      );
      expect(await adapter.ensure()).toEqual([]);
      const voice = [...obs.inputs.values()].find(
        (input) => input.settings.window === 'TeamSpeak:Qt:ts3client_win64.exe',
      )!;
      if (scenario === 'output') obs.active = true;
      obs.windows = [
        { itemName: 'Discord', itemValue: 'Discord:Qt:discord.exe', itemEnabled: true },
      ];
      const choices = await adapter.listCommentaryApplications();
      await adapter.selectCommentaryApplication(choices.candidates[0]!.id, choices.revision);
      if (scenario === 'manual') voice.settings.window = 'Manual:Qt:manual.exe';
      if (scenario === 'manualTarget') voice.settings.window = 'Discord:Qt:discord.exe';
      if (scenario === 'failure') obs.failNextSettings = true;
      if (scenario === 'uncertain') obs.failAfterSettings = true;
      if (scenario === 'concurrent') obs.manualSettingsDuringWrite = true;
      if (scenario === 'routing') {
        const status = await adapter.readAudioRouting();
        await adapter.bindAudio({ role: 'game', selectionId: null, revision: status.revision });
      }
      const writes = obs.settingsWrites;
      const findings = await adapter.ensure();
      expect(findings.some((finding) => finding.code === 'commentary_pending')).toBe(true);
      if (scenario === 'failure' || scenario === 'uncertain' || scenario === 'concurrent')
        expect(findings.some((finding) => finding.message.includes('结果待核对'))).toBe(true);
      expect(voice.settings.window).toBe(
        scenario === 'manual'
          ? 'Manual:Qt:manual.exe'
          : scenario === 'concurrent' || scenario === 'uncertain' || scenario === 'manualTarget'
            ? 'Discord:Qt:discord.exe'
            : 'TeamSpeak:Qt:ts3client_win64.exe',
      );
      if (scenario === 'output') {
        expect(obs.settingsWrites).toBe(writes);
        obs.active = false;
        expect(await adapter.ensure()).toEqual([]);
        expect(voice.settings.window).toBe('Discord:Qt:discord.exe');
      }
      if (scenario === 'failure' || scenario === 'uncertain' || scenario === 'concurrent') {
        const after = obs.settingsWrites;
        expect(
          (await adapter.ensure()).some((finding) => finding.code === 'commentary_pending'),
        ).toBe(true);
        expect(obs.settingsWrites).toBe(after);
      }
      await adapter.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

it('applies the latest explicit application choice after output stops', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mizar-latest-switch-'));
  try {
    const obs = new FakeObs();
    fixture.client = obs;
    const owner = new RemoteCommentary(join(dir, 'preference'));
    const adapter = new ObsAdapter(
      new ObsConfigStore(join(dir, 'obs.json')),
      base,
      () => {},
      new ObsAudioRouting(join(dir, 'routing')),
      { owner, journal: join(dir, 'probe') },
    );
    expect(await adapter.ensure()).toEqual([]);
    const voice = [...obs.inputs.values()].find(
      (input) => input.settings.window === 'TeamSpeak:Qt:ts3client_win64.exe',
    )!;
    obs.active = true;
    for (const window of ['Discord:Qt:discord.exe', 'Other:Qt:other.exe']) {
      obs.windows = [{ itemName: window, itemValue: window, itemEnabled: true }];
      const choices = await adapter.listCommentaryApplications();
      await adapter.selectCommentaryApplication(choices.candidates[0]!.id, choices.revision);
    }
    expect(voice.settings.window).toBe('TeamSpeak:Qt:ts3client_win64.exe');
    expect((await adapter.ensure()).some((finding) => finding.code === 'commentary_pending')).toBe(
      true,
    );
    obs.active = false;
    expect(await adapter.ensure()).toEqual([]);
    expect(voice.settings.window).toBe('Other:Qt:other.exe');
    await adapter.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('resumes prepared switches after restart but never replays sent uncertain writes', async () => {
  for (const phase of ['prepared', 'sent']) {
    const dir = await mkdtemp(join(tmpdir(), 'mizar-switch-restart-'));
    try {
      const obs = new FakeObs();
      fixture.client = obs;
      const preference = join(dir, 'preference');
      const journal = join(dir, 'probe');
      const routingPath = join(dir, 'routing');
      const makeAdapter = () =>
        new ObsAdapter(
          new ObsConfigStore(join(dir, 'obs.json')),
          base,
          () => {},
          new ObsAudioRouting(routingPath),
          { owner: new RemoteCommentary(preference), journal },
        );
      const first = makeAdapter();
      expect(await first.ensure()).toEqual([]);
      const voice = [...obs.inputs.values()].find(
        (input) => input.settings.window === 'TeamSpeak:Qt:ts3client_win64.exe',
      )!;
      obs.windows = [
        { itemName: 'Discord', itemValue: 'Discord:Qt:discord.exe', itemEnabled: true },
      ];
      const choices = await first.listCommentaryApplications();
      await first.selectCommentaryApplication(choices.candidates[0]!.id, choices.revision);
      if (phase === 'sent') {
        obs.failAfterSettings = true;
        expect(
          (await first.ensure()).some((finding) => finding.message.includes('结果待核对')),
        ).toBe(true);
      }
      await first.close();
      const writes = obs.settingsWrites;
      const next = makeAdapter();
      const findings = await next.ensure();
      if (phase === 'prepared') {
        expect(findings).toEqual([]);
        expect(voice.settings.window).toBe('Discord:Qt:discord.exe');
        expect(obs.settingsWrites).toBe(writes + 1);
      } else {
        expect(findings.some((finding) => finding.message.includes('结果待核对'))).toBe(true);
        expect(obs.settingsWrites).toBe(writes);
      }
      await next.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

it('switches from disabled using the last confirmed owned target, including after restart', async () => {
  for (const scenario of ['normal', 'restart', 'manual']) {
    const dir = await mkdtemp(join(tmpdir(), 'mizar-disabled-switch-'));
    try {
      const obs = new FakeObs();
      fixture.client = obs;
      const preference = join(dir, 'preference');
      const journal = join(dir, 'probe');
      const routingPath = join(dir, 'routing');
      const make = () => {
        const owner = new RemoteCommentary(preference);
        return {
          owner,
          adapter: new ObsAdapter(
            new ObsConfigStore(join(dir, 'obs.json')),
            base,
            () => {},
            new ObsAudioRouting(routingPath),
            { owner, journal },
          ),
        };
      };
      let { owner, adapter } = make();
      expect(await adapter.ensure()).toEqual([]);
      const voice = [...obs.inputs.values()].find(
        (input) => input.settings.window === 'TeamSpeak:Qt:ts3client_win64.exe',
      )!;
      await adapter.setCommentaryMode('disabled', (await owner.get()).revision);
      if (scenario === 'restart') {
        await adapter.close();
        ({ owner, adapter } = make());
      }
      if (scenario === 'manual') voice.settings.window = 'Manual:Qt:manual.exe';
      obs.windows = [
        { itemName: 'Discord', itemValue: 'Discord:Qt:discord.exe', itemEnabled: true },
      ];
      const choices = await adapter.listCommentaryApplications();
      await adapter.selectCommentaryApplication(choices.candidates[0]!.id, choices.revision);
      const findings = await adapter.ensure();
      if (scenario === 'manual') {
        expect(findings.some((finding) => finding.code === 'commentary_pending')).toBe(true);
        expect(voice.settings.window).toBe('Manual:Qt:manual.exe');
      } else {
        expect(findings).toEqual([]);
        expect(voice.settings.window).toBe('Discord:Qt:discord.exe');
      }
      expect((await new RemoteCommentary(preference).get()).preference.mode).toBe('application');
      await adapter.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

it('switches an explicitly selected owned input but never retargets an external input', async () => {
  for (const external of [false, true]) {
    const dir = await mkdtemp(join(tmpdir(), 'mizar-existing-switch-'));
    try {
      const obs = new FakeObs();
      fixture.client = obs;
      const owner = new RemoteCommentary(join(dir, 'preference'));
      const adapter = new ObsAdapter(
        new ObsConfigStore(join(dir, 'obs.json')),
        base,
        () => {},
        new ObsAudioRouting(join(dir, 'routing')),
        { owner, journal: join(dir, 'probe') },
      );
      expect(await adapter.ensure()).toEqual([]);
      const voice = [...obs.inputs.values()].find(
        (input) => input.settings.window === 'TeamSpeak:Qt:ts3client_win64.exe',
      )!;
      const user = external
        ? obs.addInput('User voice', 'wasapi_process_output_capture', {
            window: 'User:Qt:user.exe',
          })
        : voice;
      const status = await adapter.readAudioRouting();
      await adapter.bindAudio({
        role: 'remoteCommentary',
        selectionId: status.candidates.find((candidate) => candidate.uuid === user.inputUuid)!
          .selectionId,
        revision: status.revision,
      });
      obs.windows = [
        { itemName: 'Discord', itemValue: 'Discord:Qt:discord.exe', itemEnabled: true },
      ];
      const choices = await adapter.listCommentaryApplications();
      await adapter.selectCommentaryApplication(choices.candidates[0]!.id, choices.revision);
      const findings = await adapter.ensure();
      if (external) {
        expect(findings.some((finding) => finding.code === 'commentary_pending')).toBe(true);
        expect(user.settings.window).toBe('User:Qt:user.exe');
        expect(voice.settings.window).toBe('TeamSpeak:Qt:ts3client_win64.exe');
      } else {
        expect(findings).toEqual([]);
        expect(voice.settings.window).toBe('Discord:Qt:discord.exe');
      }
      await adapter.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

it('restores TS from disabled using the confirmed owned application target', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mizar-disabled-auto-'));
  try {
    const obs = new FakeObs();
    fixture.client = obs;
    const owner = new RemoteCommentary(join(dir, 'preference'));
    const adapter = new ObsAdapter(
      new ObsConfigStore(join(dir, 'obs.json')),
      base,
      () => {},
      new ObsAudioRouting(join(dir, 'routing')),
      { owner, journal: join(dir, 'probe') },
    );
    expect(await adapter.ensure()).toEqual([]);
    const voice = [...obs.inputs.values()].find(
      (input) => input.settings.window === 'TeamSpeak:Qt:ts3client_win64.exe',
    )!;
    obs.windows = [{ itemName: 'Discord', itemValue: 'Discord:Qt:discord.exe', itemEnabled: true }];
    const choices = await adapter.listCommentaryApplications();
    await adapter.selectCommentaryApplication(choices.candidates[0]!.id, choices.revision);
    expect(await adapter.ensure()).toEqual([]);
    await adapter.setCommentaryMode('disabled', (await owner.get()).revision);
    obs.windows = [
      { itemName: 'TeamSpeak', itemValue: 'TeamSpeak:Qt:ts3client_win64.exe', itemEnabled: true },
    ];
    await adapter.setCommentaryMode('autoTeamspeak', (await owner.get()).revision);
    expect(await adapter.ensure()).toEqual([]);
    expect(voice.settings.window).toBe('TeamSpeak:Qt:ts3client_win64.exe');
    await adapter.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('never records a baseline when the owned target is manually changed during binding', async () => {
  for (const restore of [false, true]) {
    const dir = await mkdtemp(join(tmpdir(), 'mizar-baseline-takeover-'));
    try {
      const obs = new FakeObs();
      fixture.client = obs;
      const owner = new RemoteCommentary(join(dir, 'preference'));
      const journal = join(dir, 'probe');
      const routing = new ObsAudioRouting(join(dir, 'routing'));
      routing.onChanged(() => {
        const voice = [...obs.inputs.values()].find(
          (input) => input.settings.window === 'TeamSpeak:Qt:ts3client_win64.exe',
        )!;
        voice.settings.window = 'Manual:Qt:manual.exe';
        obs.emit('InputSettingsChanged', {
          inputUuid: voice.inputUuid,
          inputSettings: { ...voice.settings },
        });
        if (restore) {
          voice.settings.window = 'TeamSpeak:Qt:ts3client_win64.exe';
          obs.emit('InputSettingsChanged', {
            inputUuid: voice.inputUuid,
            inputSettings: { ...voice.settings },
          });
        }
      });
      const adapter = new ObsAdapter(
        new ObsConfigStore(join(dir, 'obs.json')),
        base,
        () => {},
        routing,
        { owner, journal },
      );
      expect(
        (await adapter.ensure()).some((finding) => finding.code === 'commentary_pending'),
      ).toBe(true);
      const { readOwnedCommentaryTarget } = await import('../src/obs/commentary-owned-target.js');
      expect(await readOwnedCommentaryTarget(`${journal}.owned-target`)).toBeNull();
      await adapter.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

it('observes target changes during template inspection before recording the baseline', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mizar-baseline-inspection-'));
  try {
    const obs = new FakeObs();
    obs.changeTargetDuringInspection = true;
    fixture.client = obs;
    const journal = join(dir, 'probe');
    const adapter = new ObsAdapter(
      new ObsConfigStore(join(dir, 'obs.json')),
      base,
      () => {},
      new ObsAudioRouting(join(dir, 'routing')),
      { owner: new RemoteCommentary(join(dir, 'preference')), journal },
    );
    expect((await adapter.ensure()).some((finding) => finding.code === 'commentary_pending')).toBe(
      true,
    );
    const { readOwnedCommentaryTarget } = await import('../src/obs/commentary-owned-target.js');
    expect(await readOwnedCommentaryTarget(`${journal}.owned-target`)).toBeNull();
    for (const items of obs.scenes.values())
      expect(
        items.find((item) => item.sourceName === 'Mizar · Desktop Audio')!.sceneItemEnabled,
      ).toBe(true);
    await adapter.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('cleans up only its unconfirmed baseline when final readback fails', async () => {
  for (const replaced of [false, true]) {
    const dir = await mkdtemp(join(tmpdir(), 'mizar-baseline-read-failure-'));
    try {
      const obs = new FakeObs();
      fixture.client = obs;
      const journal = join(dir, 'probe');
      const { readOwnedCommentaryTarget, saveOwnedCommentaryTarget } =
        await import('../src/obs/commentary-owned-target.js');
      obs.onInputSettings = async (input) => {
        if (input.inputKind !== 'wasapi_process_output_capture') return;
        const baseline = await readOwnedCommentaryTarget(`${journal}.owned-target`);
        if (!baseline) return;
        delete obs.onInputSettings;
        obs.emit('InputSettingsChanged', {
          inputUuid: input.inputUuid,
          inputSettings: { ...input.settings, window: 'Manual:Qt:manual.exe' },
        });
        obs.emit('InputSettingsChanged', {
          inputUuid: input.inputUuid,
          inputSettings: { ...input.settings },
        });
        if (replaced)
          await saveOwnedCommentaryTarget(`${journal}.owned-target`, {
            ...baseline,
            window: 'Replacement:Qt:other.exe',
          });
        throw new Error('final_readback_failed');
      };
      const adapter = new ObsAdapter(
        new ObsConfigStore(join(dir, 'obs.json')),
        base,
        () => {},
        new ObsAudioRouting(join(dir, 'routing')),
        { owner: new RemoteCommentary(join(dir, 'preference')), journal },
      );
      expect(
        (await adapter.ensure()).some((finding) => finding.code === 'commentary_pending'),
      ).toBe(true);
      const baseline = await readOwnedCommentaryTarget(`${journal}.owned-target`);
      if (replaced) expect(baseline?.window).toBe('Replacement:Qt:other.exe');
      else expect(baseline).toBeNull();
      await adapter.close();
      expect(obs.listenerCount('InputSettingsChanged')).toBe(0);
      expect(obs.listenerCount('ConnectionClosed')).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});
