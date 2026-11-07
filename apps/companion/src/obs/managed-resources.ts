import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { PROGRAM_SCENES } from '@mizar/protocol/program-scenes';
import { OBS_CAPTURE_INPUT, OBS_COLLECTION, obsDesiredScenes } from './desired-state.js';
import type { ObsRpc } from './reconcile.js';
import { assertNoVideoOutput } from './video-transaction.js';

type Row = Record<string, unknown>;
const identitySchema = z
  .object({
    uuid: z.string().min(1),
    kind: z.string().min(1),
    version: z.number().int().min(0).max(1),
  })
  .strict();
const registrySchema = z
  .object({
    endpoint: z.string().url(),
    collection: z.literal(OBS_COLLECTION),
    instance: z.string().min(1),
    collectionIdentity: z.string().min(1),
    roles: z.record(z.string(), identitySchema),
    registration: z
      .object({
        instance: z.enum(['required', 'submitted', 'confirmed']),
        collection: z.enum(['required', 'submitted', 'confirmed']),
      })
      .strict()
      .optional(),
  })
  .strict();
type Identity = z.infer<typeof identitySchema>;
type Registry = z.infer<typeof registrySchema>;
const rows = (value: unknown): Row[] => (Array.isArray(value) ? (value as Row[]) : []);
const conflict = () =>
  new Error('OBS 资源身份未确认。请保留现有来源，在停止所有输出后检查场景配置。');

// Shared across every bind (and store instance), not just calls on one RPC wrapper.
const initializationLocks = new Map<string, Promise<void>>();
async function exclusiveInitialization<T>(key: string, run: () => Promise<T>): Promise<T> {
  const previous = initializationLocks.get(key) ?? Promise.resolve();
  const task = previous.then(run, run);
  const tail = task.then(
    () => undefined,
    () => undefined,
  );
  initializationLocks.set(key, tail);
  try {
    return await task;
  } finally {
    if (initializationLocks.get(key) === tail) initializationLocks.delete(key);
  }
}

/** Only ownership evidence is persisted here. Connection/output/playback belong to their owners. */
export class ManagedObsResources {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly path: string) {}
  private async load(): Promise<Registry[]> {
    try {
      const value: unknown = JSON.parse(await readFile(this.path, 'utf8'));
      return z.array(registrySchema).parse(value);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }
  private async save(registry: Registry): Promise<void> {
    const task = this.queue.then(async () => {
      const all = await this.load();
      const previous = all.find(
        (item) => item.endpoint === registry.endpoint && item.collection === registry.collection,
      );
      if (
        previous &&
        (previous.instance !== registry.instance ||
          previous.collectionIdentity !== registry.collectionIdentity)
      )
        throw conflict();
      if (previous) registry.roles = { ...previous.roles, ...registry.roles };
      const next = all.filter(
        (item) => item.endpoint !== registry.endpoint || item.collection !== registry.collection,
      );
      next.push(registry);
      await mkdir(dirname(this.path), { recursive: true });
      const temp = `${this.path}.${randomUUID()}.tmp`;
      await writeFile(temp, JSON.stringify(next), { mode: 0o600 });
      await rename(temp, this.path);
    });
    this.queue = task.catch(() => undefined);
    await task;
  }

  private async registerMarkers(raw: ObsRpc, registry: Registry): Promise<void> {
    if (!registry.registration) return;
    for (const [key, realm, value] of [
      ['instance', 'OBS_WEBSOCKET_DATA', registry.instance],
      ['collection', 'SCENE_COLLECTION', registry.collectionIdentity],
    ] as const) {
      if (
        (await raw.call('GetSceneCollectionList')).currentSceneCollectionName !==
        registry.collection
      )
        throw conflict();
      const args = { realm, slotName: 'mizar.resource-owner.v1' };
      const actual = (await raw.call('GetPersistentData', args)).slotValue;
      if (actual === value) {
        registry.registration[key] = 'confirmed';
        await this.save(registry);
        continue;
      }
      // A submitted-but-unconfirmed write is observed, never blindly sent again.
      if (registry.registration[key] !== 'required' || (typeof actual === 'string' && actual))
        throw new Error('OBS 资源身份登记结果尚未确认，未重复写入。请保留现有配置并重新检查。');
      await assertNoVideoOutput(raw);
      registry.registration[key] = 'submitted';
      await this.save(registry);
      let submissionFailure: unknown;
      try {
        await raw.call('SetPersistentData', { ...args, slotValue: value });
      } catch (error) {
        submissionFailure = error;
      }
      let observed: unknown;
      try {
        observed = (await raw.call('GetPersistentData', args)).slotValue;
      } catch (error) {
        throw new AggregateError(
          submissionFailure === undefined ? [error] : [submissionFailure, error],
          'OBS 资源身份登记结果尚未确认。',
          { cause: error },
        );
      }
      if (observed !== value)
        throw new Error('OBS 资源身份登记结果尚未确认。', { cause: submissionFailure });
      registry.registration[key] = 'confirmed';
      await this.save(registry);
    }
    delete registry.registration;
    await this.save(registry);
  }

  /** All consumers use role labels locally; only verified UUIDs cross the OBS boundary. */
  async bind(raw: ObsRpc, endpoint: string, baseUrl: string): Promise<ObsRpc> {
    const desired = obsDesiredScenes(baseUrl);
    const specs = new Map<string, { role: string; kind: string; legacy: string; path?: string }>();
    for (const scene of desired) {
      const title = PROGRAM_SCENES.find((item) => item.id === scene.id)!.title;
      specs.set(scene.sceneName, {
        role: `scene:${scene.id}`,
        kind: 'scene',
        legacy: `Mizar · ${title}`,
      });
      specs.set(scene.browserInput, {
        role: `browser:${scene.id}`,
        kind: 'browser_source',
        legacy: `Mizar · ${scene.id} · Program`,
        path: new URL(scene.browserUrl).pathname,
      });
    }
    specs.set(OBS_CAPTURE_INPUT, {
      role: 'capture',
      kind: 'game_capture',
      legacy: 'Mizar · CS2 Game Capture',
    });
    specs.set('禁选紧凑底栏', {
      role: 'bp-compact',
      kind: 'browser_source',
      legacy: 'Mizar · BP 紧凑底栏',
      path: '/program/bp-compact',
    });
    let registry: Registry | undefined;
    let loaded = false;
    let inputRows: Row[] = [],
      sceneRows: Row[] = [];
    const verifyScope = async () => {
      const collection = await raw.call('GetSceneCollectionList');
      if (collection.currentSceneCollectionName !== OBS_COLLECTION) throw conflict();
      if (registry) {
        const marker = await raw.call('GetPersistentData', {
          realm: 'OBS_WEBSOCKET_DATA',
          slotName: 'mizar.resource-owner.v1',
        });
        if (marker.slotValue !== registry.instance) throw conflict();
        const collectionMarker = await raw.call('GetPersistentData', {
          realm: 'SCENE_COLLECTION',
          slotName: 'mizar.resource-owner.v1',
        });
        if (collectionMarker.slotValue !== registry.collectionIdentity) throw conflict();
      }
    };
    let loading: Promise<void> | undefined;
    const initializeOnce = async () => {
      if (loaded) return;
      registry = (await this.load()).find(
        (item) => item.endpoint === endpoint && item.collection === OBS_COLLECTION,
      );
      if (registry?.registration) await this.registerMarkers(raw, registry);
      await verifyScope();
      inputRows = rows((await raw.call('GetInputList')).inputs);
      sceneRows = rows((await raw.call('GetSceneList')).scenes);
      if (!registry) {
        // Adoption is performed only once, with a complete structural proof, never a prefix.
        const roles: Record<string, Identity> = {};
        for (const [name, spec] of specs) {
          if (spec.kind === 'scene') continue;
          const candidates = inputRows.filter(
            (item) => item.inputName === name || item.inputName === spec.legacy,
          );
          if (!candidates.length) continue;
          if (candidates.length !== 1) throw conflict();
          const input = candidates[0]!;
          if (input.inputKind !== spec.kind || typeof input.inputUuid !== 'string')
            throw conflict();
          const settings = (await raw.call('GetInputSettings', { inputUuid: input.inputUuid }))
            .inputSettings as Row | undefined;
          if (spec.path) {
            let url: URL;
            try {
              url = new URL(String(settings?.url));
            } catch {
              throw conflict();
            }
            if (
              url.protocol !== 'http:' ||
              url.hostname !== '127.0.0.1' ||
              url.pathname !== spec.path ||
              url.username ||
              url.password ||
              url.search ||
              url.hash
            )
              throw conflict();
          } else if (
            settings?.capture_mode !== 'window' ||
            !/^.+:.+:cs2\.exe$/i.test(String(settings.window))
          )
            throw conflict();
          roles[spec.role] = { uuid: input.inputUuid, kind: spec.kind, version: 0 };
        }
        for (const scene of desired) {
          const spec = specs.get(scene.sceneName)!;
          const candidates = sceneRows.filter(
            (item) => item.sceneName === scene.sceneName || item.sceneName === spec.legacy,
          );
          if (!candidates.length) continue;
          if (candidates.length !== 1 || typeof candidates[0]!.sceneUuid !== 'string')
            throw conflict();
          const uuid = candidates[0]!.sceneUuid as string;
          const items = rows((await raw.call('GetSceneItemList', { sceneUuid: uuid })).sceneItems);
          if (
            !scene.sources.every(
              (name) =>
                roles[specs.get(name)!.role] &&
                items.some((item) => item.sourceUuid === roles[specs.get(name)!.role]!.uuid),
            )
          )
            throw conflict();
          roles[spec.role] = { uuid, kind: 'scene', version: 0 };
        }
        // A capture source alone is not proof of ownership.
        if (
          roles.capture &&
          !desired.some(
            (scene) => scene.composition === 'gameplay_overlay' && roles[`scene:${scene.id}`],
          )
        )
          throw conflict();
        await assertNoVideoOutput(raw);
        const readMarker = async (realm: string) =>
          (await raw.call('GetPersistentData', { realm, slotName: 'mizar.resource-owner.v1' }))
            .slotValue;
        const marker = await readMarker('OBS_WEBSOCKET_DATA');
        const collectionMarker = await readMarker('SCENE_COLLECTION');
        const hasInstance = typeof marker === 'string' && marker.length > 0;
        const hasCollection = typeof collectionMarker === 'string' && collectionMarker.length > 0;
        registry = {
          endpoint,
          collection: OBS_COLLECTION,
          instance: hasInstance ? marker : randomUUID(),
          collectionIdentity: hasCollection ? collectionMarker : randomUUID(),
          roles,
          registration: {
            instance: hasInstance ? 'confirmed' : 'required',
            collection: hasCollection ? 'confirmed' : 'required',
          },
        };
        // Reserve the exact intended marker identities before any external write.
        await this.save(registry);
        await this.registerMarkers(raw, registry);
        await verifyScope();
      }
      for (const [role, identity] of Object.entries(registry.roles)) {
        const name = [...specs].find(([, spec]) => spec.role === role)?.[0];
        if (!name) throw conflict();
        const candidates = identity.kind === 'scene' ? sceneRows : inputRows;
        const uuidKey = identity.kind === 'scene' ? 'sceneUuid' : 'inputUuid';
        const nameKey = identity.kind === 'scene' ? 'sceneName' : 'inputName';
        const found = candidates.find((item) => item[uuidKey] === identity.uuid);
        if (found && identity.kind !== 'scene' && found.inputKind !== identity.kind)
          throw conflict();
        if (candidates.some((item) => item[nameKey] === name && item[uuidKey] !== identity.uuid))
          throw conflict();
      }
      loaded = true;
    };
    const initialize = (): Promise<void> => {
      loading ??= exclusiveInitialization(`${endpoint}|${OBS_COLLECTION}`, initializeOnce).catch(
        (error: unknown) => {
          loading = undefined;
          throw error;
        },
      );
      return loading;
    };
    const canonical = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(canonical);
      if (!value || typeof value !== 'object') return value;
      const result = { ...(value as Row) };
      for (const [role, identity] of Object.entries(registry?.roles ?? {})) {
        const name = [...specs].find(([, spec]) => spec.role === role)?.[0];
        if (!name) continue;
        for (const prefix of [
          'input',
          'source',
          'scene',
          'currentProgramScene',
          'currentPreviewScene',
        ]) {
          if (result[`${prefix}Uuid`] === identity.uuid) result[`${prefix}Name`] = name;
        }
      }
      for (const [key, child] of Object.entries(result))
        if (Array.isArray(child)) result[key] = canonical(child);
      return result;
    };
    return {
      ...raw,
      confirmManagedMigration: async () => {
        await initialize();
        await verifyScope();
        const inputs = rows((await raw.call('GetInputList')).inputs);
        const scenes = rows((await raw.call('GetSceneList')).scenes);
        let changed = false;
        for (const identity of Object.values(registry!.roles)) {
          const present =
            identity.kind === 'scene'
              ? scenes.some((item) => item.sceneUuid === identity.uuid)
              : inputs.some(
                  (item) => item.inputUuid === identity.uuid && item.inputKind === identity.kind,
                );
          if (present && identity.version === 0) {
            identity.version = 1;
            changed = true;
          }
        }
        if (changed) await this.save(registry!);
      },
      ownershipScope: async () => {
        await initialize();
        await verifyScope();
        return `${endpoint}|${OBS_COLLECTION}|${registry!.instance}|${registry!.collectionIdentity}`;
      },
      call: async (type, args) => {
        if (
          ['GetSceneCollectionList', 'CreateSceneCollection', 'SetCurrentSceneCollection'].includes(
            type,
          )
        ) {
          if (type !== 'GetSceneCollectionList') {
            loaded = false;
            loading = undefined;
          }
          return raw.call(type, args);
        }
        if (!/Scene|Input|Source/.test(type)) return raw.call(type, args);
        const scope = await raw.call('GetSceneCollectionList');
        if (scope.currentSceneCollectionName !== OBS_COLLECTION) {
          if (/^(Create|Set|Remove|Press|Trigger)/.test(type)) throw conflict();
          return raw.call(type, args);
        }
        await initialize();
        if (/^(Create|Set|Remove|Press|Trigger)/.test(type)) await verifyScope();
        const data = { ...args };
        for (const prefix of ['scene', 'input', 'source']) {
          const name = data[`${prefix}Name`];
          if (typeof name !== 'string' || !specs.has(name)) continue;
          if (
            (type === 'CreateInput' && prefix === 'input') ||
            (type === 'CreateScene' && prefix === 'scene')
          )
            continue;
          const identity = registry!.roles[specs.get(name)!.role];
          if (!identity) throw conflict();
          await verifyScope();
          data[`${prefix}Uuid`] = identity.uuid;
          delete data[`${prefix}Name`];
        }
        const creating =
          type === 'CreateInput'
            ? data.inputName
            : type === 'CreateScene'
              ? data.sceneName
              : undefined;
        if (typeof creating === 'string' && specs.has(creating)) {
          await assertNoVideoOutput(raw);
          await verifyScope();
        }
        if (/^(CreateSceneItem|RemoveSceneItem|SetInputName|SetSceneName)$/.test(type)) {
          await assertNoVideoOutput(raw);
          await verifyScope();
        }
        const result = await raw.call(type, args ? data : undefined);
        if (typeof creating === 'string' && specs.has(creating)) {
          const spec = specs.get(creating)!;
          const uuid = result[spec.kind === 'scene' ? 'sceneUuid' : 'inputUuid'];
          if (typeof uuid !== 'string') throw conflict();
          registry!.roles[spec.role] = { uuid, kind: spec.kind, version: 0 };
          await this.save(registry!);
          await verifyScope();
          const listed =
            spec.kind === 'scene'
              ? rows((await raw.call('GetSceneList')).scenes)
              : rows((await raw.call('GetInputList')).inputs);
          const confirmed = listed.some(
            (item) =>
              item[spec.kind === 'scene' ? 'sceneUuid' : 'inputUuid'] === uuid &&
              (spec.kind === 'scene' || item.inputKind === spec.kind),
          );
          if (!confirmed) throw conflict();
          if (spec.kind !== 'scene') {
            const actual = (await raw.call('GetInputSettings', { inputUuid: uuid }))
              .inputSettings as Row | undefined;
            const requested = data.inputSettings as Row | undefined;
            if (
              requested &&
              !Object.entries(requested).every(([key, value]) => actual?.[key] === value)
            )
              throw conflict();
          }
          registry!.roles[spec.role]!.version = 1;
          await this.save(registry!);
        }
        if (type === 'SetInputSettings' && typeof data.inputUuid === 'string') {
          const entry = Object.values(registry!.roles).find((item) => item.uuid === data.inputUuid);
          if (entry && entry.version === 0) {
            const actual = (await raw.call('GetInputSettings', { inputUuid: entry.uuid }))
              .inputSettings as Row | undefined;
            const requested = data.inputSettings as Row | undefined;
            if (
              requested &&
              Object.entries(requested).every(([key, value]) => actual?.[key] === value)
            ) {
              entry.version = 1;
              await this.save(registry!);
            }
          }
        }
        return canonical(result) as Row;
      },
    };
  }
}
