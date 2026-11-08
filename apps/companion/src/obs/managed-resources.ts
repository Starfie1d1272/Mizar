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
    pending: z.record(z.string(), z.string()).optional(),
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
const conflict = () => new Error('OBS 资源身份未确认。请保留现有来源并检查 Mizar 场景配置。');
const markerArgs = {
  realm: 'OBS_WEBSOCKET_DATA_REALM_GLOBAL',
  slotName: 'mizar.resource-owner.v1',
};

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

  private async registerMarker(raw: ObsRpc, registry: Registry): Promise<void> {
    const actual = (await raw.call('GetPersistentData', markerArgs)).slotValue;
    if (actual !== registry.instance) {
      if (actual !== null && actual !== undefined && actual !== '') throw conflict();
      // A fixed marker value is idempotent. Unlike CreateInput, a lost reply may
      // be retried after observing the same empty slot, using the reserved value.
      registry.registration = { instance: 'submitted', collection: 'confirmed' };
      await this.save(registry);
      let submissionFailure: unknown;
      try {
        await raw.call('SetPersistentData', { ...markerArgs, slotValue: registry.instance });
      } catch (error) {
        submissionFailure = error;
      }
      let observed: unknown;
      try {
        observed = (await raw.call('GetPersistentData', markerArgs)).slotValue;
      } catch (error) {
        throw new AggregateError(
          submissionFailure === undefined ? [error] : [submissionFailure, error],
          'OBS 资源身份登记结果尚未确认。',
          { cause: error },
        );
      }
      if (observed !== registry.instance)
        throw new Error('OBS 资源身份登记结果尚未确认，请重试配置场景。', {
          cause: submissionFailure,
        });
    }
    if (registry.registration) {
      delete registry.registration;
      await this.save(registry);
    }
  }

  /** Owned role aliases resolve to UUIDs; unregistered read requests stay read-only. */
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
    let observed = false;
    const load = async () => {
      registry = (await this.load()).find(
        (item) => item.endpoint === endpoint && item.collection === OBS_COLLECTION,
      );
    };
    const inventory = async () => ({
      inputs: rows((await raw.call('GetInputList')).inputs),
      scenes: rows((await raw.call('GetSceneList')).scenes),
    });
    const collection = async () => {
      if ((await raw.call('GetSceneCollectionList')).currentSceneCollectionName !== OBS_COLLECTION)
        throw conflict();
    };
    const verifyInventory = ({ inputs, scenes }: Awaited<ReturnType<typeof inventory>>) => {
      let present = 0;
      for (const [role, identity] of Object.entries(registry!.roles)) {
        const spec = [...specs].find(([, value]) => value.role === role);
        if (!spec || spec[1].kind !== identity.kind) throw conflict();
        const candidates = identity.kind === 'scene' ? scenes : inputs;
        const uuidKey = identity.kind === 'scene' ? 'sceneUuid' : 'inputUuid';
        const nameKey = identity.kind === 'scene' ? 'sceneName' : 'inputName';
        const found = candidates.find((item) => item[uuidKey] === identity.uuid);
        if (found) {
          if (identity.kind !== 'scene' && found.inputKind !== identity.kind) throw conflict();
          present++;
        }
        if (candidates.some((item) => item[nameKey] === spec[0] && item[uuidKey] !== identity.uuid))
          throw conflict();
      }
      // A same-named replacement collection is not the previously owned graph.
      if (Object.keys(registry!.roles).length && !present) throw conflict();
    };
    const verifyScope = async () => {
      await collection();
      if (
        !registry ||
        (await raw.call('GetPersistentData', markerArgs)).slotValue !== registry.instance
      )
        throw conflict();
      verifyInventory(await inventory());
    };
    const observe = async () => {
      if (!observed) {
        await load();
        if (registry && !registry.registration) await verifyScope();
        observed = true;
      }
      return !!registry && !registry.registration;
    };
    const adopt = () =>
      exclusiveInitialization(`${this.path}|${endpoint}`, async () => {
        await load();
        await collection();
        if (registry) {
          // Existing identities and unfinished intents are never replaced by names.
          verifyInventory(await inventory());
          if (registry.registration) await this.registerMarker(raw, registry);
          await verifyScope();
          observed = true;
          return;
        }
        await assertNoVideoOutput(raw);
        const { inputs, scenes } = await inventory();
        const roles: Record<string, Identity> = {};
        for (const [name, spec] of specs) {
          if (spec.kind === 'scene') continue;
          const candidates = inputs.filter(
            (item) => item.inputName === name || item.inputName === spec.legacy,
          );
          if (!candidates.length) continue;
          if (candidates.length !== 1) throw conflict();
          const input = candidates[0]!;
          if (
            input.inputKind !== spec.kind ||
            typeof input.inputUuid !== 'string' ||
            !input.inputUuid
          )
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
          roles[spec.role] = { uuid: input.inputUuid, kind: spec.kind, version: 1 };
        }
        const attached = new Set<string>();
        for (const scene of desired) {
          const spec = specs.get(scene.sceneName)!;
          const candidates = scenes.filter(
            (item) => item.sceneName === scene.sceneName || item.sceneName === spec.legacy,
          );
          if (!candidates.length) continue;
          if (
            candidates.length !== 1 ||
            typeof candidates[0]!.sceneUuid !== 'string' ||
            !candidates[0]!.sceneUuid
          )
            throw conflict();
          const uuid = candidates[0]!.sceneUuid as string;
          const items = rows((await raw.call('GetSceneItemList', { sceneUuid: uuid })).sceneItems);
          if (
            !scene.sources.every((name) => {
              const role = specs.get(name)!.role;
              if (!roles[role] || !items.some((item) => item.sourceUuid === roles[role]!.uuid))
                return false;
              attached.add(role);
              return true;
            })
          )
            throw conflict();
          roles[spec.role] = { uuid, kind: 'scene', version: 1 };
        }
        // A plausible source name/settings without its expected graph is not ownership.
        if (
          Object.entries(roles).some(
            ([role, value]) =>
              value.kind !== 'scene' && role !== 'bp-compact' && !attached.has(role),
          )
        )
          throw conflict();
        if (roles['bp-compact']) {
          const scene = roles['scene:gameplay'];
          if (
            !scene ||
            !rows((await raw.call('GetSceneItemList', { sceneUuid: scene.uuid })).sceneItems).some(
              (item) => item.sourceUuid === roles['bp-compact']!.uuid,
            )
          )
            throw conflict();
        }
        const marker = (await raw.call('GetPersistentData', markerArgs)).slotValue;
        if (marker !== null && marker !== undefined && marker !== '' && typeof marker !== 'string')
          throw conflict();
        registry = {
          endpoint,
          collection: OBS_COLLECTION,
          instance: typeof marker === 'string' && marker ? marker : randomUUID(),
          // Local registry identity, NOT an OBS profile or a remote collection marker.
          collectionIdentity: randomUUID(),
          roles,
          registration: { instance: 'required', collection: 'confirmed' },
        };
        await collection();
        await this.save(registry);
        await this.registerMarker(raw, registry);
        await verifyScope();
        observed = true;
      });
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
      observeManagedResources: observe,
      adoptManagedResources: adopt,
      ownershipScope: async () => {
        if (!(await observe())) throw conflict();
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
            observed = false;
            registry = undefined;
          }
          return raw.call(type, args);
        }
        if (!/Scene|Input|Source/.test(type)) return raw.call(type, args);
        const scope = await raw.call('GetSceneCollectionList');
        if (scope.currentSceneCollectionName !== OBS_COLLECTION) {
          if (/^(Create|Set|Remove|Press|Trigger)/.test(type)) throw conflict();
          return raw.call(type, args);
        }
        const owned = await observe();
        const mutating = /^(Create|Set|Remove|Press|Trigger)/.test(type);
        if (!owned) {
          if (mutating) throw conflict();
          return raw.call(type, args);
        }
        if (mutating) await verifyScope();
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
          if (registry!.pending?.[specs.get(creating)!.role])
            throw new Error('OBS 来源创建结果尚未确认，未重复创建。请保留现有来源并检查诊断。');
          await assertNoVideoOutput(raw);
          await verifyScope();
          registry!.pending ??= {};
          registry!.pending[specs.get(creating)!.role] = creating;
          await this.save(registry!);
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
          delete registry!.pending?.[spec.role];
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
        return canonical(result) as Row;
      },
    };
  }
}
