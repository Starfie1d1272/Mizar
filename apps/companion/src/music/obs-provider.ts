import { diagnosticValue } from '../support/session-journal.js';
import { OBSWebSocket } from 'obs-websocket-js/json';
import type { ObsConfigStore } from '../obs/config.js';
import type { ObsRpc } from '../obs/reconcile.js';
import { OBS_COLLECTION, obsDesiredScenes } from '../obs/desired-state.js';
import { looping, type MusicStore } from './store.js';

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
  ) {}
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
          this.retryAt = Date.now() + 2000;
          await this.close();
          throw new Error('music_obs_unavailable', {
            cause: error,
          });
        } finally {
          if (timer) clearTimeout(timer);
        }
      },
    };
    return run(rpc, this.epoch);
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

/** UUID + unpredictable installation name, never a display-name-only ownership assumption. */
export async function ownedMusicInput(
  obs: ObsRpc,
  store: MusicStore,
  layer: MusicLayer,
  create: boolean,
  valid: () => boolean,
  attach = true,
  preservePlayback = false,
  renameLegacy = true,
) {
  const assertCurrent = () => {
    if (!valid()) throw new Error('music_cancelled');
  };
  assertCurrent();
  const collection = await obs.call('GetSceneCollectionList');
  if (collection.currentSceneCollectionName !== OBS_COLLECTION)
    throw new Error('music_collection_inactive');
  const legacyName = `Mizar · ${layer === 'bgm' ? 'BGM' : 'Stinger'} · ${store.state.owner}`;
  const baseName = layer === 'bgm' ? '音乐' : '音效';
  const inputs = (await obs.call('GetInputList')).inputs as {
    inputName: string;
    inputKind: string;
    inputUuid?: string;
  }[];
  const expected = store.state.sources[layer];
  const found = expected ? inputs.find((i) => i.inputUuid === expected) : undefined;
  let name = found?.inputName ?? baseName;
  if (renameLegacy && found?.inputName === legacyName && found.inputKind === 'ffmpeg_source') {
    const [stream, record] = await Promise.all([
      obs.call('GetStreamStatus'),
      obs.call('GetRecordStatus'),
    ]);
    if (stream.outputActive === false && record.outputActive === false) {
      name = baseName;
      for (let index = 2; inputs.some((input) => input.inputName === name); index++)
        name = `${baseName} ${index}`;
      assertCurrent();
      await obs.call('SetInputName', { inputUuid: expected, newInputName: name });
    }
  } else if (!found) {
    if (
      inputs.some(
        (i) =>
          i.inputName === legacyName ||
          (expected &&
            (i.inputName === baseName ||
              (i.inputName.startsWith(`${baseName} `) &&
                /^\d+$/.test(i.inputName.slice(baseName.length + 1))))),
      )
    )
      throw new Error('music_source_conflict');
    for (let index = 2; inputs.some((input) => input.inputName === name); index++)
      name = `${baseName} ${index}`;
  }
  if (found) {
    if (!expected || found.inputUuid !== expected || found.inputKind !== 'ffmpeg_source')
      throw new Error('music_source_conflict');
  } else {
    if (!create) return null;
    // Missing sources may be recreated, but existing unowned ones are never adopted.
    const sceneNames = ((await obs.call('GetSceneList')).scenes as { sceneName: string }[]).map(
      (s) => s.sceneName,
    );
    const scenes = obsDesiredScenes('http://127.0.0.1:3000').filter((s) =>
      sceneNames.includes(s.sceneName),
    );
    if (!scenes.length) throw new Error('music_scenes_missing');
    assertCurrent();
    const result = await obs.call('CreateInput', {
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
      sceneItemEnabled: true,
    });
    if (typeof result.inputUuid !== 'string') throw new Error('music_obs_version');
    await store.update((s) => {
      s.sources[layer] = result.inputUuid as string;
      const previous = s[layer];
      if (previous && !preservePlayback) {
        if (looping(previous.group)) s[layer] = null;
        else {
          s[layer] = { ...previous, finished: true };
          s.consumed = [...s.consumed, previous.key].slice(-64);
        }
      }
    });
  }
  if (create && (attach || !found)) {
    const sceneNames = ((await obs.call('GetSceneList')).scenes as { sceneName: string }[]).map(
      (s) => s.sceneName,
    );
    for (const scene of obsDesiredScenes('http://127.0.0.1:3000').filter((s) =>
      sceneNames.includes(s.sceneName),
    )) {
      assertCurrent();
      const items = (await obs.call('GetSceneItemList', { sceneName: scene.sceneName }))
        .sceneItems as { sourceName: string; sourceUuid: string; sceneItemId: number }[];
      const owned = items.filter((i) => i.sourceUuid === store.state.sources[layer]);
      if (!owned.length) {
        assertCurrent();
        const result = await obs.call('CreateSceneItem', {
          sceneName: scene.sceneName,
          sourceUuid: store.state.sources[layer],
          sceneItemEnabled: false,
        });
        owned.push({
          sourceName: name,
          sourceUuid: store.state.sources[layer]!,
          sceneItemId: result.sceneItemId as number,
        });
      }
      for (const item of owned) {
        assertCurrent();
        // A media source can decode embedded album art as video. Keep the item
        // active for audio, but give its video no area in the broadcast canvas.
        await obs.call('SetSceneItemTransform', {
          sceneName: scene.sceneName,
          sceneItemId: item.sceneItemId,
          sceneItemTransform: { boundsType: 'OBS_BOUNDS_NONE', scaleX: 0, scaleY: 0 },
        });
        if (!items.some((i) => i.sceneItemId === item.sceneItemId)) {
          assertCurrent();
          await obs.call('SetSceneItemEnabled', {
            sceneName: scene.sceneName,
            sceneItemId: item.sceneItemId,
            sceneItemEnabled: true,
          });
        }
      }
    }
  }
  assertCurrent();
  return name;
}
