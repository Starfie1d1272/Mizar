import { assertNoVideoOutput } from '../obs/video-transaction.js';
import { diagnosticValue } from '../support/session-journal.js';
import { OBSWebSocket } from 'obs-websocket-js/json';
import type { ObsConfigStore } from '../obs/config.js';
import type { ObsRpc } from '../obs/reconcile.js';
import { OBS_COLLECTION, obsDesiredScenes } from '../obs/desired-state.js';
import { looping, type MusicStore, type MusicState } from './store.js';

export type MusicLayer = 'bgm' | 'stinger';
export class ObsMusicProvider {
  private client: OBSWebSocket | null = null;
  private signature = '';
  private connected = false;
  private epoch = 0;
  private retryAt = 0;
  private knownSecrets: readonly string[] = [];
  constructor(
    private readonly config: ObsConfigStore,
    private readonly diagnostic: (stage: string, evidence: unknown) => void = () => {},
    private readonly onMonitorSettingsChanged: () => void = () => {},
  ) {}
  get isConnected(): boolean {
    return this.connected;
  }
  private trace(stage: string, evidence: unknown, secrets = this.knownSecrets) {
    try {
      this.diagnostic(stage, diagnosticValue(evidence, '', new Set(), secrets));
    } catch {
      /* Diagnostics cannot change playback or connection ownership. */
    }
  }
  async session<T>(run: (rpc: ObsRpc, epoch: number) => Promise<T>): Promise<T> {
    if (!this.connected && Date.now() < this.retryAt) throw new Error('music_obs_unavailable');
    const config = await this.config.read();
    const signature = JSON.stringify([config.host, config.port, config.password]);
    if (signature !== this.signature || !this.connected) {
      await this.close();
      this.knownSecrets = [config.password];
      this.trace('music_obs_connect', { result: 'begin', host: config.host, port: config.port });
      const client = new OBSWebSocket();
      this.client = client;
      client.on('InputAudioMonitorTypeChanged', () => this.onMonitorSettingsChanged());
      client.on('CurrentProfileChanged', () => this.onMonitorSettingsChanged());
      client.on('ConnectionClosed', (error) => {
        if (this.client === client) {
          this.connected = false;
          this.trace('music_obs_connection_closed', { epoch: this.epoch, error }, [
            config.password,
          ]);
        }
      });
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          client.connect(`ws://${config.host}:${config.port}`, config.password, { rpcVersion: 1 }),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('music_obs_timeout')), 2000);
          }),
        ]);
      } catch (error) {
        this.trace('music_obs_connect', { result: 'failure', retryAfterMs: 2000, error }, [
          config.password,
        ]);
        this.retryAt = Date.now() + 2000;
        await this.close();
        throw new Error('music_obs_unavailable', {
          cause: error,
        });
      } finally {
        if (timer) clearTimeout(timer);
      }
      this.retryAt = 0;
      this.signature = signature;
      this.connected = true;
      this.epoch++;
      this.trace('music_obs_connect', {
        result: 'success',
        epoch: this.epoch,
        host: config.host,
        port: config.port,
      });
    }
    const client = this.client!;
    const rpc: ObsRpc = {
      call: async (name, data) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          return await Promise.race([
            (
              client.call as (
                name: string,
                data?: Record<string, unknown>,
              ) => Promise<Record<string, unknown>>
            )(name, data),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error('music_obs_timeout')), 2000);
            }),
          ]);
        } catch (error) {
          this.trace(
            'music_obs_request',
            { result: 'failure', request: name, parameters: data, error },
            [config.password],
          );
          // An OBS request rejection is not a disconnected WebSocket.
          if (!this.connected) {
            this.retryAt = Date.now() + 2000;
            throw new Error('music_obs_unavailable', { cause: error });
          }
          const code = (error as { code?: unknown } | undefined)?.code;
          throw new Error(code === 600 ? 'music_source_missing' : 'music_playback_failed', {
            cause: error,
          });
        } finally {
          if (timer) clearTimeout(timer);
        }
      },
    };
    return run(
      await this.config.managedResources.bind(
        rpc,
        `ws://${config.host}:${config.port}`,
        'http://127.0.0.1:3000',
      ),
      this.epoch,
    );
  }
  async close() {
    this.connected = false;
    const client = this.client;
    this.client = null;
    if (client) {
      const epoch = this.epoch,
        secrets = this.knownSecrets;
      this.trace('music_obs_disconnect', { result: 'begin', epoch });
      let completed = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        client
          .disconnect()
          .then(() => {
            completed = true;
            this.trace('music_obs_disconnect', { result: 'success', epoch }, secrets);
          })
          .catch((error: unknown) => {
            completed = true;
            this.trace('music_obs_disconnect', { result: 'failure', epoch, error }, secrets);
          }),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 200);
        }),
      ]);
      if (timer) clearTimeout(timer);
      if (!completed)
        this.trace('music_obs_disconnect', { result: 'wait_timeout', epoch, waitMs: 200 }, secrets);
    }
  }
}

type Initialization = MusicState['sourceInitialization'][number];
const geometryKeys = [
  'positionX',
  'positionY',
  'rotation',
  'scaleX',
  'scaleY',
  'boundsType',
  'boundsWidth',
  'boundsHeight',
  'boundsAlignment',
  'alignment',
  'cropLeft',
  'cropRight',
  'cropTop',
  'cropBottom',
];
function geometry(value: unknown): Record<string, number | string> {
  if (!value || typeof value !== 'object') throw new Error('music_initialization_unconfirmed');
  const record = value as Record<string, unknown>;
  if (
    typeof record.scaleX !== 'number' ||
    typeof record.scaleY !== 'number' ||
    typeof record.boundsType !== 'string'
  )
    throw new Error('music_initialization_unconfirmed');
  return Object.fromEntries(
    geometryKeys.flatMap((key) =>
      typeof record[key] === 'number' || typeof record[key] === 'string'
        ? [[key, record[key] as number | string]]
        : [],
    ),
  );
}
const sameGeometry = (a: Record<string, number | string>, b: Record<string, number | string>) =>
  geometryKeys.every((key) => a[key] === b[key]);
const initialGeometry = {
  positionX: 0,
  positionY: 0,
  rotation: 0,
  scaleX: 1,
  scaleY: 1,
  boundsType: 'OBS_BOUNDS_NONE',
  boundsWidth: 0,
  boundsHeight: 0,
  boundsAlignment: 0,
  alignment: 5,
  cropLeft: 0,
  cropRight: 0,
  cropTop: 0,
  cropBottom: 0,
};
const audioOnly = (value: Record<string, number | string>) =>
  value.boundsType === 'OBS_BOUNDS_NONE' && value.scaleX === 0 && value.scaleY === 0;
const sameItem = (a: Initialization, b: Initialization) =>
  a.layer === b.layer &&
  a.scope === b.scope &&
  a.inputUuid === b.inputUuid &&
  a.sceneUuid === b.sceneUuid &&
  a.sceneItemId === b.sceneItemId;

async function createMusicResource(
  obs: ObsRpc,
  store: MusicStore,
  intent: Initialization,
  type: 'CreateInput' | 'CreateSceneItem',
  data: Record<string, unknown>,
  valid: () => boolean,
) {
  // A missing final-dispatch hook is unknown, never evidence that nothing ran.
  let dispatched = !obs.withMutationGuard;
  const writer =
    obs.withMutationGuard?.(() => {
      if (!valid()) throw new Error('music_cancelled');
      dispatched = true;
    }) ?? obs;
  try {
    return await writer.call(type, data);
  } catch (error) {
    if (!dispatched)
      await store.update((state) => {
        state.sourceInitialization = state.sourceInitialization.filter(
          (entry) => !sameItem(entry, intent) || entry.phase !== intent.phase,
        );
      });
    throw error;
  }
}

/** Resume only a persisted unfinished item, never infer ownership from an existing layout. */
async function initializeMusicItem(
  obs: ObsRpc,
  store: MusicStore,
  pending: Initialization,
  scope: string | undefined,
  valid: () => boolean,
  newlyCreated = false,
): Promise<void> {
  const assertCurrent = () => {
    if (!valid()) throw new Error('music_cancelled');
    if (
      pending.scope !== (scope ?? null) ||
      store.state.sources[pending.layer] !== pending.inputUuid
    )
      throw new Error('music_source_conflict');
  };
  const read = async () => {
    assertCurrent();
    if (
      (await obs.call('GetSceneCollectionList')).currentSceneCollectionName !== OBS_COLLECTION ||
      ((await obs.ownershipScope?.()) ?? null) !== pending.scope
    )
      throw new Error('music_source_conflict');
    const items = (await obs.call('GetSceneItemList', { sceneUuid: pending.sceneUuid }))
      .sceneItems as { sourceUuid: string; sceneItemId: number; sceneItemEnabled: boolean }[];
    const matches = items.filter(
      (item) =>
        (pending.sceneItemId === null || item.sceneItemId === pending.sceneItemId) &&
        item.sourceUuid === pending.inputUuid,
    );
    if (matches.length !== 1 || typeof matches[0]!.sceneItemEnabled !== 'boolean')
      throw new Error('music_source_conflict');
    if (pending.phase === 'locate') {
      const sceneItemId = matches[0]!.sceneItemId;
      if (!Number.isInteger(sceneItemId)) throw new Error('music_initialization_unconfirmed');
      await store.update((state) => {
        const entry = state.sourceInitialization.find((entry) => sameItem(entry, pending));
        if (!entry) throw new Error('music_initialization_unconfirmed');
        entry.sceneItemId = sceneItemId;
        entry.phase = 'transform';
      });
      pending = { ...pending, sceneItemId, phase: 'transform' };
    }
    const transform = geometry(
      (
        await obs.call('GetSceneItemTransform', {
          sceneUuid: pending.sceneUuid,
          sceneItemId: pending.sceneItemId,
        })
      ).sceneItemTransform,
    );
    assertCurrent();
    return { enabled: matches[0]!.sceneItemEnabled, transform };
  };
  let current = await read();
  if (pending.before === null) {
    // Creation has an accepted UUID/item receipt, even if its first observation
    // was cancelled. Resume only the untouched disabled item or an audio-only
    // item already repaired by preparation, never adopt another existing layout.
    if (!newlyCreated) {
      if (!scope) throw new Error('music_source_conflict');
      await assertNoVideoOutput(obs);
      current = await read();
      if (!audioOnly(current.transform) && !sameGeometry(current.transform, initialGeometry))
        throw new Error('music_source_conflict');
    }
    if (current.enabled && !audioOnly(current.transform))
      throw new Error('music_initialization_unconfirmed');
    pending = {
      ...pending,
      before: current.transform,
      phase: audioOnly(current.transform) ? 'enable' : pending.phase,
    };
    await store.update((state) => {
      const entry = state.sourceInitialization.find((entry) => sameItem(entry, pending));
      if (!entry) throw new Error('music_initialization_unconfirmed');
      entry.before = current.transform;
      entry.phase = pending.phase;
    });
  }
  const target = { ...pending.before!, boundsType: 'OBS_BOUNDS_NONE', scaleX: 0, scaleY: 0 };
  if (pending.phase === 'transform') {
    if (
      (current.enabled && !sameGeometry(current.transform, target)) ||
      (!sameGeometry(current.transform, pending.before!) &&
        !sameGeometry(current.transform, target))
    )
      throw new Error('music_source_conflict');
    if (!sameGeometry(current.transform, target)) {
      await assertNoVideoOutput(obs);
      assertCurrent();
      await obs.call('SetSceneItemTransform', {
        sceneUuid: pending.sceneUuid,
        sceneItemId: pending.sceneItemId,
        sceneItemTransform: { boundsType: 'OBS_BOUNDS_NONE', scaleX: 0, scaleY: 0 },
      });
    }
    current = await read();
    if (!sameGeometry(current.transform, target))
      throw new Error('music_initialization_unconfirmed');
    await store.update((state) => {
      const entry = state.sourceInitialization.find((entry) => sameItem(entry, pending));
      if (!entry) throw new Error('music_initialization_unconfirmed');
      entry.phase = 'enable';
    });
  }
  current = await read();
  if (!sameGeometry(current.transform, target)) throw new Error('music_source_conflict');
  if (!current.enabled) {
    await assertNoVideoOutput(obs);
    assertCurrent();
    await obs.call('SetSceneItemEnabled', {
      sceneUuid: pending.sceneUuid,
      sceneItemId: pending.sceneItemId,
      sceneItemEnabled: true,
    });
  }
  current = await read();
  if (!current.enabled || !sameGeometry(current.transform, target))
    throw new Error('music_initialization_unconfirmed');
  await store.update((state) => {
    state.sourceInitialization = state.sourceInitialization.filter(
      (entry) => !sameItem(entry, pending),
    );
  });
}

/** UUID and dedicated collection scope, never a display-name-only ownership assumption. */
export async function ownedMusicInput(
  obs: ObsRpc,
  store: MusicStore,
  layer: MusicLayer,
  create: boolean,
  valid: () => boolean,
  attach = true,
  preservePlayback = false,
) {
  const assertCurrent = () => {
    if (!valid()) throw new Error('music_cancelled');
  };
  assertCurrent();
  const collection = await obs.call('GetSceneCollectionList');
  if (collection.currentSceneCollectionName !== OBS_COLLECTION)
    throw new Error('music_collection_inactive');
  const scope = await obs.ownershipScope?.();
  const name = layer === 'bgm' ? '音乐' : '音效';
  const creations = store.state.sourceInitialization.filter(
    (entry) => entry.layer === layer && entry.scope === (scope ?? null) && entry.phase === 'create',
  );
  if (creations.length) {
    // A missing music-store receipt can still be confirmed by the managed
    // registry's accepted UUID, but never by a matching display name alone.
    if (!scope || creations.length !== 1 || creations[0]!.requestedName !== name)
      throw new Error('music_source_conflict');
    await assertNoVideoOutput(obs);
    const registered = await obs.managedInputIdentity?.(name);
    const current = (await obs.call('GetInputList')).inputs as {
      inputName: string;
      inputKind: string;
      inputUuid?: string;
    }[];
    const accepted = registered && current.find((input) => input.inputUuid === registered.uuid);
    if (accepted && (registered.kind !== 'ffmpeg_source' || accepted.inputKind !== 'ffmpeg_source'))
      throw new Error('music_source_conflict');
    if (!accepted && current.some((input) => input.inputName === name))
      throw new Error('music_source_conflict');
    if ((await obs.ownershipScope?.()) !== scope) throw new Error('music_source_conflict');
    assertCurrent();
    await store.update((state) => {
      const index = state.sourceInitialization.findIndex(
        (entry) => sameItem(entry, creations[0]!) && entry.phase === 'create',
      );
      if (index < 0) throw new Error('music_initialization_unconfirmed');
      if (accepted) {
        if (state.sourceScopes[layer] !== scope) {
          state.desktopMonitorOriginal[layer] = null;
          state.monitorConfigured[layer] = null;
        }
        state.sources[layer] = accepted.inputUuid!;
        state.sourceScopes[layer] = scope;
        state.sourceInitialization[index] = {
          ...creations[0]!,
          inputUuid: accepted.inputUuid!,
          phase: 'locate',
        };
      } else {
        // The verified collection has no target source. Retire only this stale
        // intent; normal creation still requires idle outputs and a final guard.
        // A late arrival will hit OBS's name collision, never be adopted/deleted.
        state.sourceInitialization.splice(index, 1);
      }
    });
  }
  const inputs = (await obs.call('GetInputList')).inputs as {
    inputName: string;
    inputKind: string;
    inputUuid?: string;
  }[];
  const expected = store.state.sources[layer];
  const found = expected ? inputs.find((input) => input.inputUuid === expected) : undefined;
  if (found && scope && store.state.sourceScopes[layer] !== scope)
    throw new Error('music_source_conflict');
  if (
    !found &&
    store.state.sourceInitialization.some(
      (entry) => entry.layer === layer && entry.scope === (scope ?? null),
    )
  )
    throw new Error('music_initialization_unconfirmed');
  if (found && found.inputName !== name) {
    await assertNoVideoOutput(obs);
    await obs.call('SetInputName', { inputUuid: found.inputUuid, newInputName: name });
  }
  if (found) {
    if (!expected || found.inputUuid !== expected || found.inputKind !== 'ffmpeg_source')
      throw new Error('music_source_conflict');
  } else {
    if (!create) return null;
    if (inputs.some((input) => input.inputName === name)) throw new Error('music_source_conflict');
    // Missing sources may be recreated, but existing unowned ones are never adopted.
    const sceneList = (await obs.call('GetSceneList')).scenes as {
      sceneName: string;
      sceneUuid: string;
    }[];
    const sceneNames = sceneList.map((s) => s.sceneName);
    const scenes = obsDesiredScenes('http://127.0.0.1:3000').filter((s) =>
      sceneNames.includes(s.sceneName),
    );
    if (!scenes.length) throw new Error('music_scenes_missing');
    const sceneUuid = sceneList.find(
      (scene) => scene.sceneName === scenes[0]!.sceneName,
    )?.sceneUuid;
    if (typeof sceneUuid !== 'string') throw new Error('music_source_conflict');
    assertCurrent();
    await assertNoVideoOutput(obs);
    const creation: Initialization = {
      layer,
      scope: scope ?? null,
      inputUuid: null,
      requestedName: name,
      sceneUuid,
      sceneItemId: null,
      phase: 'create',
      before: null,
    };
    await store.update((state) => {
      state.sourceInitialization.push(creation);
    });
    const result = await createMusicResource(
      obs,
      store,
      creation,
      'CreateInput',
      {
        sceneName: scenes[0]!.sceneName,
        inputName: name,
        inputKind: 'ffmpeg_source',
        inputSettings: {
          is_local_file: true,
          local_file: '',
          looping: false,
          restart_on_activate: false,
          close_when_inactive: false,
        },
        // OBS also creates the first scene item. Do not expose album-art video
        // before that newly owned item's transform is made audio-only below.
        sceneItemEnabled: false,
      },
      valid,
    );
    if (typeof result.inputUuid !== 'string') throw new Error('music_obs_version');
    // Persist the accepted source before the first fallible item query. An unknown
    // item id remains a locate intent, never permission to create another source.
    const pending: Initialization = {
      layer,
      scope: scope ?? null,
      inputUuid: result.inputUuid,
      sceneUuid,
      sceneItemId: Number.isInteger(result.sceneItemId) ? (result.sceneItemId as number) : null,
      phase: Number.isInteger(result.sceneItemId) ? 'transform' : 'locate',
      before: null,
    };
    await store.update((s) => {
      if (s.sourceScopes[layer] !== scope) {
        s.desktopMonitorOriginal[layer] = null;
        s.monitorConfigured[layer] = null;
      }
      s.sources[layer] = result.inputUuid as string;
      const index = s.sourceInitialization.findIndex(
        (entry) => sameItem(entry, creation) && entry.phase === 'create',
      );
      if (index < 0) throw new Error('music_initialization_unconfirmed');
      s.sourceInitialization[index] = pending;
      if (scope) s.sourceScopes[layer] = scope;
      const previous = s[layer];
      if (previous && !preservePlayback) {
        if (looping(previous.group)) s[layer] = null;
        else {
          s[layer] = { ...previous, finished: true };
          s.consumed = [...s.consumed, previous.key].slice(-64);
        }
      }
    });
    await initializeMusicItem(obs, store, pending, scope, valid, true);
  }
  for (const pending of store.state.sourceInitialization.filter(
    (entry) => entry.layer === layer && entry.scope === (scope ?? null),
  )) {
    await initializeMusicItem(obs, store, pending, scope, valid);
  }
  if (create && (attach || !found)) {
    const sceneList = (await obs.call('GetSceneList')).scenes as {
      sceneName: string;
      sceneUuid: string;
    }[];
    const sceneNames = sceneList.map((s) => s.sceneName);
    for (const scene of obsDesiredScenes('http://127.0.0.1:3000').filter((s) =>
      sceneNames.includes(s.sceneName),
    )) {
      assertCurrent();
      const items = (await obs.call('GetSceneItemList', { sceneName: scene.sceneName }))
        .sceneItems as { sourceName: string; sourceUuid: string; sceneItemId: number }[];
      const owned = items.filter((i) => i.sourceUuid === store.state.sources[layer]);
      if (owned.length) continue; // Existing layouts are not initialization evidence.
      const sceneUuid = sceneList.find((item) => item.sceneName === scene.sceneName)?.sceneUuid;
      if (typeof sceneUuid !== 'string') throw new Error('music_source_conflict');
      assertCurrent();
      await assertNoVideoOutput(obs);
      const pending: Initialization = {
        layer,
        scope: scope ?? null,
        inputUuid: store.state.sources[layer]!,
        sceneUuid,
        sceneItemId: null,
        phase: 'locate',
        before: null,
      };
      // Attaching is also a side effect: retain an unresolved exact-source intent
      // before dispatch so a lost reply cannot become an unjournaled disabled item.
      await store.update((state) => {
        state.sourceInitialization.push(pending);
      });
      const result = await createMusicResource(
        obs,
        store,
        pending,
        'CreateSceneItem',
        {
          sceneUuid,
          sourceUuid: store.state.sources[layer],
          sceneItemEnabled: false,
        },
        valid,
      );
      if (Number.isInteger(result.sceneItemId)) {
        await store.update((state) => {
          const entry = state.sourceInitialization.find((entry) => sameItem(entry, pending));
          if (!entry) throw new Error('music_initialization_unconfirmed');
          entry.sceneItemId = result.sceneItemId as number;
          entry.phase = 'transform';
        });
        pending.sceneItemId = result.sceneItemId as number;
        pending.phase = 'transform';
      }
      await initializeMusicItem(obs, store, pending, scope, valid, true);
    }
  }
  assertCurrent();
  return name;
}
