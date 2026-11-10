import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  OBS_CAPTURE_INPUT,
  OBS_COLLECTION,
  OBS_HEIGHT,
  OBS_WIDTH,
  obsDesiredScenes,
} from './desired-state.js';
import type { ObsRpc, ObsVisualProtection } from './reconcile.js';
import { assertNoVideoOutput, ObsVideoError } from './video-transaction.js';

type Row = Record<string, unknown>;
const identitySchema = z
  .object({
    uuid: z.string().min(1),
    kind: z.string().min(1),
    settings: z.record(z.string(), z.unknown()).optional(),
    enabled: z.boolean().optional(),
  })
  .strict();
const registrySchema = z
  .object({
    endpoint: z.string().url(),
    instance: z.string().uuid(),
    collectionIdentity: z.string().uuid(),
    roles: z.record(z.string(), identitySchema),
    creating: z.boolean(),
    creationSent: z.boolean().default(false),
  })
  .strict();
type Registry = z.infer<typeof registrySchema>;
const rows = (value: unknown): Row[] => {
  if (!Array.isArray(value)) throw new Error('OBS 来源列表未确认。');
  return value as Row[];
};
const conflict = () =>
  new ObsVideoError(
    'collection_ownership_unknown',
    '无法确认「Mizar 制播」专用集合的归属。请保留现有集合并检查诊断；不会接管同名个人集合。',
  );
const markerArgs = {
  realm: 'OBS_WEBSOCKET_DATA_REALM_GLOBAL',
  slotName: 'mizar.dedicated-collection.v1',
};

/** The collection is the ownership boundary. Roles only keep stable identities and fixed names. */
export class ManagedObsResources {
  private queue: Promise<unknown> = Promise.resolve();
  private initialization: Promise<unknown> = Promise.resolve();
  constructor(private readonly path: string) {}
  private async load(): Promise<Registry[]> {
    try {
      return z.array(registrySchema).parse(JSON.parse(await readFile(this.path, 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }
  private async save(registry: Registry): Promise<void> {
    const task = this.queue.then(async () => {
      const all = await this.load();
      const previous = all.find((item) => item.endpoint === registry.endpoint);
      if (previous && previous.collectionIdentity !== registry.collectionIdentity) throw conflict();
      registry.roles = { ...previous?.roles, ...registry.roles };
      const next = all.filter((item) => item.endpoint !== registry.endpoint);
      next.push(structuredClone(registry));
      await mkdir(dirname(this.path), { recursive: true });
      const temp = `${this.path}.${randomUUID()}.tmp`;
      await writeFile(temp, JSON.stringify(next), { mode: 0o600 });
      await rename(temp, this.path);
    });
    this.queue = task.catch(() => undefined);
    await task;
  }

  async bind(raw: ObsRpc, endpoint: string, baseUrl: string): Promise<ObsRpc> {
    const desired = obsDesiredScenes(baseUrl);
    const specs = new Map<string, string>([
      ...desired.flatMap((scene): [string, string][] => [
        [scene.sceneName, 'scene'],
        [scene.browserInput, 'browser_source'],
      ]),
      [OBS_CAPTURE_INPUT, 'game_capture'],
      ['禁选紧凑底栏', 'browser_source'],
      ['桌面声音', 'wasapi_output_capture'],
      ['麦克风', 'wasapi_input_capture'],
      ['游戏声音', 'wasapi_process_output_capture'],
      ['其他解说', 'wasapi_process_output_capture'],
      ['音乐', 'ffmpeg_source'],
      ['音效', 'ffmpeg_source'],
    ]);
    const saved = await this.load();
    let registry = saved.find((item) => item.endpoint === endpoint);
    const inventory = async () => ({
      inputs: rows((await raw.call('GetInputList')).inputs),
      scenes: rows((await raw.call('GetSceneList')).scenes),
    });
    const active = async () =>
      (await raw.call('GetSceneCollectionList')).currentSceneCollectionName === OBS_COLLECTION;
    const hasRegisteredIdentity = (item: Registry, inputs: Row[], scenes: Row[]) =>
      Object.values(item.roles).some((role) =>
        role.kind === 'scene'
          ? scenes.some((row) => row.sceneUuid === role.uuid)
          : inputs.some((row) => row.inputUuid === role.uuid && row.inputKind === role.kind),
      );
    // A changed address first resolves an instance candidate, not write authority.
    // Read-only calls never select a collection. Explicit preparation may select
    // the dedicated collection, but must prove its saved UUID graph before repair.
    if (!registry && saved.length) {
      const marker = (await raw.call('GetPersistentData', markerArgs)).slotValue;
      let matches = saved.filter((item) => !item.creating && item.instance === marker);
      if (matches.length && (await active())) {
        const { inputs, scenes } = await inventory();
        matches = matches.filter((item) => hasRegisteredIdentity(item, inputs, scenes));
      }
      if (matches.length > 1) throw conflict();
      registry = matches[0];
    }
    const identityEndpoint = registry?.endpoint ?? endpoint;
    const verify = async () => {
      registry = (await this.load()).find((item) => item.endpoint === identityEndpoint);
      if (
        !registry ||
        registry.creating ||
        !(await active()) ||
        (await raw.call('GetPersistentData', markerArgs)).slotValue !== registry.instance
      )
        throw conflict();
      const { inputs, scenes } = await inventory();
      // A deleted/recreated same-name collection is not proof of ownership. A
      // surviving UUID lets us repair every other manually removed/changed role.
      if (!hasRegisteredIdentity(registry, inputs, scenes)) throw conflict();
    };
    const observe = async () => {
      if (!registry) return false;
      const marker = (await raw.call('GetPersistentData', markerArgs)).slotValue;
      if (!marker && !registry.creating) return false;
      await verify();
      return true;
    };
    const prepare = async (allowChange: boolean, writer: ObsRpc, beforeMutation?: () => void) => {
      registry = (await this.load()).find((item) => item.endpoint === identityEndpoint);
      await assertNoVideoOutput(raw);
      const collection = await raw.call('GetSceneCollectionList');
      if (typeof collection.currentSceneCollectionName !== 'string') throw conflict();
      const exists =
        Array.isArray(collection.sceneCollections) &&
        collection.sceneCollections.includes(OBS_COLLECTION);
      if (!allowChange && collection.currentSceneCollectionName !== OBS_COLLECTION)
        throw conflict();
      let switchedFrom: string | undefined;
      try {
        if (!registry) {
          if (exists) throw conflict();
          const marker = (await raw.call('GetPersistentData', markerArgs)).slotValue;
          if (marker && !z.string().uuid().safeParse(marker).success) throw conflict();
          registry = {
            endpoint,
            instance: typeof marker === 'string' && marker ? marker : randomUUID(),
            collectionIdentity: randomUUID(),
            roles: {},
            creating: true,
            creationSent: false,
          };
          await this.save(registry);
        }
        if (registry.creating) {
          if (registry.creationSent || exists) throw conflict();
          await assertNoVideoOutput(writer);
          registry.creationSent = true;
          await this.save(registry);
          try {
            await assertNoVideoOutput(writer);
            beforeMutation?.();
          } catch (error) {
            // The collection request has not been dispatched. Preserve the same
            // reserved identity, but permit a later explicit preparation to retry.
            registry.creationSent = false;
            await this.save(registry);
            throw error;
          }
          await raw.call('CreateSceneCollection', { sceneCollectionName: OBS_COLLECTION });
          if (!(await active())) throw conflict();
          const initial = await inventory();
          for (const [index, scene] of initial.scenes.entries()) {
            if (typeof scene.sceneUuid !== 'string') throw conflict();
            registry.roles[`bootstrap:${index}`] = { uuid: scene.sceneUuid, kind: 'scene' };
          }
          if (!Object.keys(registry.roles).length) throw conflict();
          registry.creating = false;
          registry.creationSent = false;
          await this.save(registry);
        } else {
          if (!exists) throw conflict();
          if (collection.currentSceneCollectionName !== OBS_COLLECTION) {
            await assertNoVideoOutput(writer);
            beforeMutation?.();
            switchedFrom = collection.currentSceneCollectionName;
            await raw.call('SetCurrentSceneCollection', { sceneCollectionName: OBS_COLLECTION });
          }
        }
        const marker = (await raw.call('GetPersistentData', markerArgs)).slotValue;
        if (marker !== registry.instance) {
          if (marker || !(await active())) throw conflict();
          const { inputs, scenes } = await inventory();
          if (!hasRegisteredIdentity(registry, inputs, scenes)) throw conflict();
          await assertNoVideoOutput(writer);
          // An empty slot plus the saved UUID graph permits this idempotent
          // registration to resume after a lost reply, never a foreign marker.
          beforeMutation?.();
          await raw.call('SetPersistentData', { ...markerArgs, slotValue: registry.instance });
        }
        await verify();
      } catch (cause) {
        if (switchedFrom) {
          try {
            await assertNoVideoOutput(writer);
            if (!(await active())) throw conflict();
            beforeMutation?.();
            await raw.call('SetCurrentSceneCollection', { sceneCollectionName: switchedFrom });
            if (
              (await raw.call('GetSceneCollectionList')).currentSceneCollectionName !== switchedFrom
            )
              throw conflict();
          } catch (recovery) {
            throw new AggregateError([cause], 'OBS 专用集合核验失败，无法安全返回原集合。', {
              cause: recovery,
            });
          }
        }
        throw cause;
      }
    };
    const globalInputs = async () => {
      const specials = await raw.call('GetSpecialInputs');
      const inputs = (await inventory()).inputs;
      return Object.entries(specials)
        .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && !!entry[1])
        .map(([slot, name]) => {
          const input = inputs.find((row) => row.inputName === name);
          if (!input || typeof input.inputUuid !== 'string')
            throw new Error('OBS 全局音频身份未确认。');
          return { ...input, slot, inputName: String(input.inputName), inputUuid: input.inputUuid };
        });
    };
    const drift = async () => {
      await verify();
      const { inputs, scenes } = await inventory();
      for (const [name, kind] of specs) {
        if (audio.has(name)) continue;
        const role = registry!.roles[name];
        const row = (kind === 'scene' ? scenes : inputs).find(
          (item) => (item.sceneUuid ?? item.inputUuid) === role?.uuid,
        );
        const named = (kind === 'scene' ? scenes : inputs).find(
          (item) => (item.sceneName ?? item.inputName) === name,
        );
        if (
          (named && (named.sceneUuid ?? named.inputUuid) !== role?.uuid) ||
          (row &&
            ((row.sceneName ?? row.inputName) !== name ||
              (kind !== 'scene' && row.inputKind !== kind)))
        )
          return true;
      }
      for (const spec of desired) {
        const scene = scenes.find(
          (item) => item.sceneUuid === registry!.roles[spec.sceneName]?.uuid,
        );
        if (!scene) continue;
        const seen = new Set<unknown>();
        for (const item of rows(
          (await raw.call('GetSceneItemList', { sceneUuid: scene.sceneUuid })).sceneItems,
        )) {
          if (!visualName(String(item.sourceName))) continue;
          if (seen.has(item.sourceUuid) || !allowedItem(spec.id, String(item.sourceName)))
            return true;
          seen.add(item.sourceUuid);
        }
      }
      return false;
    };
    const audio = new Set(['桌面声音', '麦克风', '游戏声音', '其他解说', '音乐', '音效']);
    const visualName = (name: string) => specs.has(name) && !audio.has(name);
    const allowedItem = (id: string, name: string) => {
      const scene = desired.find((value) => value.id === id)!;
      return (
        scene.sources.includes(name) ||
        audio.has(name) ||
        (id === 'gameplay' && name === '禁选紧凑底栏')
      );
    };
    const protectsSource = async (
      protection: ObsVisualProtection,
      item: Row,
      visited = new Set<string>(),
    ): Promise<boolean> => {
      if (protection.sourceUuids?.includes(String(item.sourceUuid))) return true;
      if ((!item.isGroup && !item.sceneUuid) || !protection.sourceUuids?.length) return false;
      const uuid = String(item.sourceUuid ?? item.sceneUuid ?? '');
      if (!uuid || visited.has(uuid)) return true;
      visited.add(uuid);
      const children = rows(
        (
          await raw.call(item.isGroup ? 'GetGroupSceneItemList' : 'GetSceneItemList', {
            sceneUuid: uuid,
          })
        ).sceneItems,
      );
      for (const child of children)
        if (await protectsSource(protection, child, visited)) return true;
      visited.delete(uuid);
      return false;
    };
    const normalize = async (
      writer: ObsRpc,
      visualsOnly = false,
      protection: ObsVisualProtection = {},
    ) => {
      await assertNoVideoOutput(raw);
      await verify();
      const globals = visualsOnly ? [] : await globalInputs();
      // OBS has no SetSpecialInputs request. Silence collection-local globals
      // and monitoring, then verify rather than claiming RemoveInput detached them.
      for (const input of visualsOnly ? [] : globals) {
        const names: Record<string, string> = {
          desktop1: '全局桌面主路（已停用）',
          desktop2: '全局桌面辅路（已停用）',
          mic1: '全局麦克风主路（已停用）',
          mic2: '全局麦克风辅路（已停用）',
          mic3: '全局麦克风备用（已停用）',
          mic4: '全局麦克风扩展（已停用）',
        };
        const name = names[input.slot];
        if (!name) throw new Error('OBS 全局音频通道未确认。');
        const collision = (await inventory()).inputs.find(
          (row) => row.inputName === name && row.inputUuid !== input.inputUuid,
        );
        if (collision && protection.sourceUuids?.includes(String(collision.inputUuid)))
          throw new ObsVideoError(
            'audio_resource_conflict',
            '音频恢复仍持有同名来源，请先核对并恢复该音频来源。',
          );
        if (collision) await writer.call('RemoveInput', { inputUuid: collision.inputUuid });
        if (input.inputName !== name)
          await writer.call('SetInputName', { inputUuid: input.inputUuid, newInputName: name });
        await writer.call('SetInputMute', { inputUuid: input.inputUuid, inputMuted: true });
        await writer.call('SetInputAudioMonitorType', {
          inputUuid: input.inputUuid,
          monitorType: 'OBS_MONITORING_TYPE_NONE',
        });
      }
      // Keep an initial scene until the real scenes exist, so there is always a
      // durable identity anchor and OBS never has to remove its final scene.
      const blocked: string[] = [];
      let listed = await inventory();
      for (const [name, kind] of specs) {
        if (visualsOnly && audio.has(name)) continue;
        const role = registry!.roles[name];
        const candidates = kind === 'scene' ? listed.scenes : listed.inputs;
        const found =
          role &&
          candidates.find(
            (row) => (kind === 'scene' ? row.sceneUuid : row.inputUuid) === role.uuid,
          );
        const collision = [...listed.inputs, ...listed.scenes].find(
          (row) =>
            (row.inputName ?? row.sceneName) === name &&
            (row.inputUuid ?? row.sceneUuid) !== role?.uuid,
        );
        if (
          collision &&
          (protection.sourceUuids?.includes(String(collision.inputUuid)) ||
            (collision.sceneUuid && (await protectsSource(protection, collision))) ||
            (visualsOnly &&
              (collision.sceneUuid ||
                !['browser_source', 'game_capture'].includes(String(collision.inputKind)))))
        ) {
          blocked.push(name);
          continue;
        }
        if (collision && !globals.some((input) => input.inputUuid === collision.inputUuid)) {
          await writer.call(
            collision.sceneUuid ? 'RemoveScene' : 'RemoveInput',
            collision.sceneUuid
              ? { sceneUuid: collision.sceneUuid }
              : { inputUuid: collision.inputUuid },
          );
        }
        if (found && (kind === 'scene' ? found.sceneName : found.inputName) !== name)
          await writer.call(
            kind === 'scene' ? 'SetSceneName' : 'SetInputName',
            kind === 'scene'
              ? { sceneUuid: role!.uuid, newSceneName: name }
              : { inputUuid: role!.uuid, newInputName: name },
          );
        if (found && role?.settings && audio.has(name))
          await writer.call('SetInputSettings', {
            inputUuid: role.uuid,
            inputSettings: role.settings,
            overlay: false,
          });
        if (found && name === '禁选紧凑底栏')
          await writer.call('SetInputSettings', {
            inputUuid: role!.uuid,
            inputSettings: {
              url: new URL('/program/bp-compact', baseUrl).toString(),
              width: OBS_WIDTH,
              height: OBS_HEIGHT,
            },
            overlay: false,
          });
        if (found && (kind === 'browser_source' || (!visualsOnly && kind === 'game_capture'))) {
          const filters = rows(
            (await raw.call('GetSourceFilterList', { sourceUuid: role!.uuid })).filters,
          );
          for (const filter of filters)
            await writer.call('RemoveSourceFilter', {
              sourceUuid: role!.uuid,
              filterName: filter.filterName,
            });
        }
        listed = await inventory();
      }
      return blocked;
    };
    const prune = async (
      writer: ObsRpc,
      visualsOnly = false,
      protection: ObsVisualProtection = {},
    ) => {
      await assertNoVideoOutput(raw);
      await verify();
      const globals = visualsOnly ? [] : await globalInputs();
      const listed = await inventory();
      for (const [name, role] of visualsOnly ? [] : Object.entries(registry!.roles)) {
        if (
          ![
            'wasapi_output_capture',
            'wasapi_input_capture',
            'wasapi_process_output_capture',
          ].includes(role.kind)
        )
          continue;
        if (name === '麦克风' && listed.inputs.some((input) => input.inputUuid === role.uuid)) {
          let enabled = false;
          for (const scene of listed.scenes) {
            const items = rows(
              (await raw.call('GetSceneItemList', { sceneUuid: scene.sceneUuid })).sceneItems,
            );
            if (
              items.some((item) => item.sourceUuid === role.uuid && item.sceneItemEnabled === true)
            )
              enabled = true;
          }
          role.enabled = enabled;
          await this.save(registry!);
        }
        if (listed.inputs.some((input) => input.inputUuid === role.uuid)) {
          const waiting = rows(
            (await raw.call('GetSceneItemList', { sceneName: desired[0]!.sceneName })).sceneItems,
          );
          if (!waiting.some((item) => item.sourceUuid === role.uuid)) {
            let enabled = false;
            if (name === '麦克风')
              for (const scene of listed.scenes) {
                const items = rows(
                  (await raw.call('GetSceneItemList', { sceneUuid: scene.sceneUuid })).sceneItems,
                );
                if (
                  items.some(
                    (item) => item.sourceUuid === role.uuid && item.sceneItemEnabled === true,
                  )
                ) {
                  enabled = true;
                  break;
                }
              }
            await writer.call('CreateSceneItem', {
              sceneName: desired[0]!.sceneName,
              sourceName: name,
              sceneItemEnabled: enabled,
            });
          }
        } else
          await writer.call('CreateInput', {
            sceneName: desired[0]!.sceneName,
            inputName: name,
            inputKind: role.kind,
            inputSettings: role.settings ?? {},
            sceneItemEnabled: name === '麦克风' && role.enabled !== false,
          });
      }
      const { scenes } = await inventory();
      for (const scene of scenes) {
        const wanted = desired.find(
          (value) => registry!.roles[value.sceneName]?.uuid === scene.sceneUuid,
        );
        if (!wanted) {
          if (visualsOnly) continue;
          const items = rows(
            (await raw.call('GetSceneItemList', { sceneUuid: scene.sceneUuid })).sceneItems,
          );
          let protectedScene = false;
          for (const item of items)
            if (await protectsSource(protection, item)) protectedScene = true;
          if (protectedScene) continue;
          await writer.call('RemoveScene', { sceneUuid: scene.sceneUuid });
          continue;
        }
        const seen = new Set<unknown>();
        for (const item of rows(
          (await raw.call('GetSceneItemList', { sceneUuid: scene.sceneUuid })).sceneItems,
        )) {
          if (visualsOnly && !visualName(String(item.sourceName))) continue;
          if (
            (await protectsSource(protection, item)) ||
            protection.items?.some(
              (ref) =>
                ref.sceneName === wanted.sceneName &&
                ref.sceneItemId === item.sceneItemId &&
                ref.sourceUuid === item.sourceUuid,
            )
          )
            continue;
          if (
            seen.has(item.sourceUuid) ||
            !allowedItem(wanted.id, String(item.sourceName)) ||
            globals.some((input) => input.inputUuid === item.sourceUuid)
          )
            await writer.call('RemoveSceneItem', {
              sceneUuid: scene.sceneUuid,
              sceneItemId: item.sceneItemId,
            });
          else {
            seen.add(item.sourceUuid);
            if (item.sourceName === '禁选紧凑底栏')
              await writer.call('SetSceneItemEnabled', {
                sceneUuid: scene.sceneUuid,
                sceneItemId: item.sceneItemId,
                sceneItemEnabled: false,
              });
            if (item.sourceName === '音乐' || item.sourceName === '音效')
              await writer.call('SetSceneItemTransform', {
                sceneUuid: scene.sceneUuid,
                sceneItemId: item.sceneItemId,
                sceneItemTransform: { boundsType: 'OBS_BOUNDS_NONE', scaleX: 0, scaleY: 0 },
              });
          }
        }
      }
      // Removing a final scene reference may already destroy its input.
      for (const input of visualsOnly ? [] : (await inventory()).inputs) {
        if (
          globals.some((global) => global.inputUuid === input.inputUuid) ||
          protection.sourceUuids?.includes(String(input.inputUuid))
        )
          continue;
        if (
          ![...specs].some(
            ([name, kind]) => kind !== 'scene' && registry!.roles[name]?.uuid === input.inputUuid,
          )
        )
          await writer.call('RemoveInput', { inputUuid: input.inputUuid });
      }
    };
    const dispatch = (type: string, data?: Row, onDispatch?: () => void) => {
      if (!raw.reportsDispatch) onDispatch?.();
      return raw.call(type, data, onDispatch);
    };
    const scoped = (beforeMutation?: () => void): ObsRpc => ({
      ...raw,
      reportsDispatch: true,
      identityEndpoint,
      withMutationGuard: (guard) =>
        scoped(() => {
          beforeMutation?.();
          guard();
        }),
      observeManagedResources: observe,
      prepareManagedCollection: (allowChange, writer) => {
        const task = this.initialization.then(() => prepare(allowChange, writer, beforeMutation));
        this.initialization = task.catch(() => undefined);
        return task;
      },
      managedResourcesDrift: drift,
      managedResourceConflicts: async () => {
        await verify();
        const { inputs, scenes } = await inventory();
        return [...specs]
          .filter(([name, kind]) => {
            if (audio.has(name)) return false;
            const named = (kind === 'scene' ? scenes : inputs).find(
              (row) => (row.sceneName ?? row.inputName) === name,
            );
            return named && (named.sceneUuid ?? named.inputUuid) !== registry!.roles[name]?.uuid;
          })
          .map(([name]) => name);
      },
      normalizeManagedResources: (writer, protection) => normalize(writer, true, protection),
      pruneManagedResources: (writer, protection) => prune(writer, true, protection),
      reconcileManagedAudioResources: async (writer, protection) => {
        if ((await normalize(writer, false, protection)).length)
          throw new ObsVideoError(
            'audio_resource_conflict',
            '音频恢复仍持有同名来源，请先核对并恢复该音频来源。',
          );
        await prune(writer, false, protection);
      },
      managedInputIdentity: async (name) => {
        await verify();
        const role = registry!.roles[name];
        return role ? { uuid: role.uuid, kind: role.kind } : null;
      },
      ownershipScope: async () => {
        await verify();
        return `${identityEndpoint}|${OBS_COLLECTION}|${registry!.instance}|${registry!.collectionIdentity}`;
      },
      call: async (type, args, onDispatch) => {
        const mutating = /^(Create|Set|Remove|Press|Trigger)/.test(type);
        if (!/Scene|Input|Source|Filter/.test(type) || type === 'GetSceneCollectionList') {
          if (mutating) beforeMutation?.();
          return dispatch(type, args, onDispatch);
        }
        if (mutating) await verify();
        const name = type === 'CreateInput' ? String(args?.inputName) : undefined;
        const previous = name ? registry?.roles[name] : undefined;
        let data =
          type === 'CreateInput' && previous?.settings && audio.has(name!)
            ? { ...args, inputSettings: previous.settings }
            : args;
        if (mutating) {
          data = { ...data };
          for (const prefix of ['scene', 'input', 'source']) {
            if (
              (prefix === 'input' && ['CreateInput', 'SetInputName'].includes(type)) ||
              (prefix === 'scene' && ['CreateScene', 'SetSceneName'].includes(type))
            )
              continue;
            const key = `${prefix}Name`;
            const role =
              typeof data[key] === 'string' ? registry?.roles[data[key] as string] : undefined;
            if (role) {
              data[`${prefix}Uuid`] = role.uuid;
              delete data[key];
            }
          }
        }
        const microphone = registry?.roles['麦克风'];
        const changesMicrophone =
          type === 'SetSceneItemEnabled' &&
          microphone &&
          rows(
            (
              await raw.call(
                'GetSceneItemList',
                data?.sceneUuid ? { sceneUuid: data.sceneUuid } : { sceneName: data?.sceneName },
              )
            ).sceneItems,
          ).some(
            (item) => item.sceneItemId === data?.sceneItemId && item.sourceUuid === microphone.uuid,
          );
        if (mutating) beforeMutation?.();
        const result = await dispatch(type, data, onDispatch);
        if (type === 'CreateScene' || type === 'CreateInput') {
          const name = String(type === 'CreateScene' ? args?.sceneName : args?.inputName);
          const kind =
            type === 'CreateInput' && audio.has(name) ? String(data?.inputKind) : specs.get(name);
          const uuid = result[type === 'CreateScene' ? 'sceneUuid' : 'inputUuid'];
          if (!kind || typeof uuid !== 'string') throw conflict();
          registry!.roles[name] = {
            uuid,
            kind,
            ...(type === 'CreateInput' && audio.has(name)
              ? {
                  settings: data?.inputSettings as Row,
                  ...(name === '麦克风' ? { enabled: data?.sceneItemEnabled === true } : {}),
                }
              : {}),
          };
          await this.save(registry!);
        }
        if (changesMicrophone && microphone) {
          let enabled = false;
          for (const scene of (await inventory()).scenes) {
            const items = rows(
              (await raw.call('GetSceneItemList', { sceneUuid: scene.sceneUuid })).sceneItems,
            );
            if (
              items.some(
                (item) => item.sourceUuid === microphone.uuid && item.sceneItemEnabled === true,
              )
            )
              enabled = true;
          }
          microphone.enabled = enabled;
          await this.save(registry!);
        }
        if (type === 'SetInputSettings') {
          const role = Object.entries(registry?.roles ?? {}).find(
            ([name, value]) =>
              audio.has(name) && (value.uuid === args?.inputUuid || name === args?.inputName),
          )?.[1];
          if (role) {
            role.settings = (await raw.call('GetInputSettings', { inputUuid: role.uuid }))
              .inputSettings as Row;
            await this.save(registry!);
          }
        }
        return result;
      },
    });
    return scoped();
  }
}
