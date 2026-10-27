import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { obsDesiredScenes, OBS_CAPTURE_INPUT } from '../src/obs/desired-state.js';
import { ObsConfigStore } from '../src/obs/config.js';
import { RemoteCommentary } from '../src/obs/remote-commentary.js';
import { ObsAudioRouting } from '../src/obs/audio-routing.js';
import { GameAudioController } from '../src/obs/audio-policy-controller.js';
import { EventSubscription } from 'obs-websocket-js';

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
  settingsWrites = 0;
  manualOverride = false;
  subscriptions = 0;
  collection = 'Mizar';
  currentScene = '';
  transforms = new Map<number, Record<string, unknown>>();
  muted = new Map<string, boolean>();
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
        return {};
      case 'GetInputSettings':
        return { inputSettings: input!.settings };
      case 'GetInputMute':
        return { inputMuted: this.muted.get(String(data.inputUuid)) ?? false };
      case 'SetInputMute':
        this.muted.set(String(data.inputUuid), Boolean(data.inputMuted));
        this.emit('InputMuteStateChanged', {
          inputUuid: data.inputUuid,
          inputMuted: data.inputMuted,
        });
        return {};
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
    expect(obs.subscriptions & EventSubscription.Config).toBeTruthy();
    expect(obs.subscriptions & EventSubscription.SceneItems).toBeTruthy();
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
    expect(obs.scenes.size).toBe(obsDesiredScenes(base).length);
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
    adapter.startCommentaryRecovery();
    await vi.waitFor(() => expect(voice.settings.window).toBe('TeamSpeak:Qt:ts3client_win64.exe'));
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
