import { createHash } from 'node:crypto';
import { MUSIC_GROUPS } from '@mizar/protocol/music';
import {
  boundModules,
  type AssetRef,
  type BroadcastConfigDocument,
  type MulnxToolRef,
  type ModuleRecord,
  type ResourceRef,
} from '@mizar/broadcast-config';
import {
  exportModule,
  analyzePackDrafts,
  readPackArchive,
  writePackArchive,
} from '@mizar/broadcast-pack';
import { audioBytes } from '../music/archive.js';
import type { MusicStore } from '../music/store.js';
import { readMusicAsset } from './music-assets.js';
import { validPackImage, type MusicPackResources } from './music-pack-resources.js';
import type { BroadcastConfigStore } from './store.js';

const resourceKey = (ref: ResourceRef) => JSON.stringify([ref.id, ref.version, ref.digest]);
const assetKey = (ref: AssetRef) => JSON.stringify([resourceKey(ref.resource), ref.fileId]);
type FileEntry = { id: string; path: string; mediaType: string; data: Buffer };

// The external dependency records acquisition, not proof that a local tool is installed.
function releaseResource(tool: MulnxToolRef): ResourceRef {
  if (tool.kind !== 'upstream') throw new Error('capability_unsupported');
  const { releaseId, assetId, tag, archiveSha256 } = tool.release;
  if (
    !Number.isSafeInteger(releaseId) ||
    releaseId <= 0 ||
    !Number.isSafeInteger(assetId) ||
    assetId <= 0 ||
    !tag ||
    tag.length > 128 ||
    !/^[a-f0-9]{64}$/.test(archiveSha256)
  )
    throw new Error('package_invalid');
  return {
    id: `upstream:mulnx:${releaseId}:${assetId}`,
    version: tag,
    digest: archiveSha256,
  };
}

function releaseTool(resource: ResourceRef): MulnxToolRef {
  const match = /^upstream:mulnx:([1-9][0-9]*):([1-9][0-9]*)$/.exec(resource.id);
  if (!match) throw new Error('capability_unsupported');
  const releaseId = Number(match[1]),
    assetId = Number(match[2]);
  if (!Number.isSafeInteger(releaseId) || !Number.isSafeInteger(assetId))
    throw new Error('package_invalid');
  return {
    kind: 'upstream',
    release: {
      repository: 'Co1Swet/MulNX_CS2',
      releaseId,
      assetId,
      tag: resource.version,
      archiveSha256: resource.digest,
    },
  };
}

/** Export one complete scheme from a single configuration snapshot. */
export async function exportPresetPack(input: {
  document: BroadcastConfigDocument;
  presetId?: string;
  presetIds?: string[];
  moduleIds?: string[];
  music: MusicStore;
  resources: MusicPackResources;
  metadata: { packageId: string; version: string; name: string; author: string };
}): Promise<Buffer> {
  const ids = input.presetIds ?? (input.presetId ? [input.presetId] : []);
  const requestedModules = input.moduleIds ?? [];
  if (
    (!ids.length && !requestedModules.length) ||
    ids.length > 32 ||
    requestedModules.length > 128 ||
    new Set(ids).size !== ids.length ||
    new Set(requestedModules).size !== requestedModules.length
  )
    throw new Error('invalid_request');
  const presets = ids.map((id) => {
    const preset = input.document.presets.find((item) => item.id === id);
    if (!preset) throw new Error('preset_missing');
    if (preset.opaqueModules.length) throw new Error('capability_unsupported');
    return { preset, bound: boundModules(preset, input.document.modules) };
  });
  const modules = new Map(
    input.document.modules
      .filter((item) => requestedModules.includes(item.id))
      .map((item) => [item.id, item]),
  );
  if (modules.size !== requestedModules.length) throw new Error('module_missing');
  for (const { bound } of presets)
    for (const module of bound.values()) if (module) modules.set(module.id, module);
  const audio = new Map<string, { id: string; path: string; data: Buffer }>();
  const images = new Map<string, { id: string; path: string; data: Buffer; mediaType: string }>();
  const addImage = async (ref: AssetRef) => {
    if (images.has(assetKey(ref))) return;
    if (!ref.resource.id.startsWith('local:mizar-pack:')) throw new Error('capability_unsupported');
    const file = await input.resources.readAsset(ref);
    if (!validPackImage(file.bytes, file.mediaType)) throw new Error('capability_unsupported');
    const id = `image-${createHash('sha256').update(file.bytes).digest('hex')}`;
    const ext = file.mediaType === 'image/jpeg' ? 'jpg' : file.mediaType.slice(6);
    images.set(assetKey(ref), {
      id,
      path: `assets/${id}.${ext}`,
      data: file.bytes,
      mediaType: file.mediaType,
    });
  };
  const addAudio = async (ref: AssetRef) => {
    if (audio.has(assetKey(ref))) return;
    const file = ref.resource.id.startsWith('local:mizar-pack:')
      ? await input.resources.read(ref)
      : { name: ref.fileId, bytes: await readMusicAsset(input.music, ref) };
    const id = `audio-${createHash('sha256').update(file.bytes).digest('hex')}`;
    audio.set(assetKey(ref), {
      id,
      path: `assets/${id}.${file.name.split('.').at(-1)!}`,
      data: file.bytes,
    });
  };
  for (const module of modules.values()) {
    if (module.kind === 'program')
      for (const ref of Object.values(module.value.assets)) await addImage(ref);
    if (module.kind === 'hud' && !('preset' in module.value))
      for (const ref of Object.values(module.value.panelAssets)) await addImage(ref);
    if (module.kind === 'music')
      for (const group of MUSIC_GROUPS)
        for (const track of module.value.groups[group].tracks) await addAudio(track.asset);
    if (module.kind === 'camera')
      for (const map of module.value.maps) {
        if (map.openingSound) await addAudio(map.openingSound.asset);
      }
  }
  const dependencies = new Map<
    string,
    { alias: string; resource: ResourceRef; delivery: { kind: 'external' } }
  >();
  const alias = (resource: ResourceRef) => {
    const key = resourceKey(resource);
    let entry = dependencies.get(key);
    if (!entry) {
      entry = {
        alias: `dependency-${dependencies.size + 1}`,
        resource,
        delivery: { kind: 'external' },
      };
      dependencies.set(key, entry);
    }
    return entry.alias;
  };
  const entries: {
    entryId: string;
    module: string;
    schemaVersion: number;
    fileId: string;
    required: boolean;
  }[] = [];
  const files: FileEntry[] = [];
  const moduleIds = new Map<string, string>();
  const presetEntries: { entryId: string; schemaVersion: 1; fileId: string }[] = [];
  for (const module of modules.values()) {
    const entryId = `module-${moduleIds.size + 1}`;
    moduleIds.set(module.id, entryId);
    const template = exportModule(module, {
      asset(ref) {
        const local = audio.get(assetKey(ref)) ?? images.get(assetKey(ref));
        return local
          ? { package: '$self', fileId: local.id }
          : { package: alias(ref.resource), fileId: ref.fileId };
      },
      resource(ref) {
        return { package: alias(ref) };
      },
      tool(ref) {
        return { package: alias(releaseResource(ref)) };
      },
    });
    entries.push({
      entryId,
      module: module.kind,
      schemaVersion: module.schemaVersion,
      fileId: entryId,
      required: true,
    });
    files.push({
      id: entryId,
      path: `modules/${entryId}.json`,
      mediaType: 'application/json',
      data: Buffer.from(JSON.stringify(template)),
    });
  }
  for (const [index, { preset }] of presets.entries()) {
    const entryId = index === 0 ? 'main' : `preset-${index + 1}`;
    const fileId = `file-${entryId}`;
    const bindings = preset.bindings.map((binding) =>
      binding.mode === 'off'
        ? binding
        : { kind: binding.kind, mode: 'use', entryId: moduleIds.get(binding.moduleId)! },
    );
    presetEntries.push({ entryId, schemaVersion: 1, fileId });
    files.push({
      id: fileId,
      path: `presets/${entryId}.json`,
      mediaType: 'application/json',
      data: Buffer.from(JSON.stringify({ name: preset.name, bindings })),
    });
  }
  for (const asset of new Map([...audio.values()].map((item) => [item.id, item])).values())
    files.push({ ...asset, mediaType: `audio/${asset.path.split('.').at(-1)!}` });
  for (const asset of new Map([...images.values()].map((item) => [item.id, item])).values())
    files.push(asset);
  const manifest = {
    format: 'mizar.pack',
    formatVersion: 1,
    ...input.metadata,
    ...(presetEntries.length ? { defaultPreset: 'main' } : {}),
    modules: entries,
    presets: presetEntries,
    dependencies: [...dependencies.values()],
    requirements: [],
    files: files.map((file) => ({
      id: file.id,
      path: file.path,
      mediaType: file.mediaType,
      bytes: file.data.length,
      sha256: createHash('sha256').update(file.data).digest('hex'),
    })),
  };
  return writePackArchive(
    Buffer.from(JSON.stringify(manifest)),
    new Map(files.map((file) => [file.path, file.data])),
  );
}

/** Inspect a verified archive without publishing it or changing configuration. */
export async function inspectPresetPack(input: {
  zip: Buffer;
  store: BroadcastConfigStore;
  availability?: (module: ModuleRecord, source: ResourceRef) => Promise<void>;
}) {
  const archive = await readPackArchive(input.zip);
  const { manifest } = archive;
  if (!manifest.presets.length && !manifest.modules.length) throw new Error('package_invalid');
  const source: ResourceRef = {
    id: `local:mizar-pack:${manifest.packageId}`,
    version: manifest.version,
    digest: archive.digest,
  };
  const files = new Map(manifest.files.map((file) => [file.id, file]));
  const dependencies = new Map(manifest.dependencies.map((entry) => [entry.alias, entry.resource]));
  const lookup = (alias: string) => {
    const ref = alias === '$self' ? source : dependencies.get(alias);
    if (!ref) throw new Error('dependency_missing');
    return ref;
  };
  const analyzed = analyzePackDrafts({
    manifestBytes: archive.manifestBytes,
    files: archive.files,
    source,
    refs: {
      asset(ref) {
        if (ref.package === '$self') {
          const file = files.get(ref.fileId);
          const bytes = file && archive.files.get(file.path);
          if (!file || !bytes) throw new Error('resource_missing');
          const ext = file.path.split('.').at(-1)?.toLowerCase();
          if (
            !file.mediaType.startsWith('audio/') &&
            !['image/png', 'image/jpeg', 'image/webp'].includes(file.mediaType)
          )
            throw new Error('capability_unsupported');
          if (
            !(file.mediaType === `audio/${ext}` && audioBytes(file.path, bytes)) &&
            !validPackImage(bytes, file.mediaType)
          )
            throw new Error('package_invalid');
        }
        return { resource: lookup(ref.package), fileId: ref.fileId };
      },
      resource(ref) {
        return lookup(ref.package);
      },
      tool(ref) {
        return releaseTool(lookup(ref.package));
      },
    },
    supports: () => false,
  });
  const index = input.store.inspectImport(source);
  const entries = await Promise.all(
    analyzed.entries.map(async (entry) => {
      let status = entry.status;
      let reason = entry.reason;
      if (entry.type === 'module' && status === 'ready' && input.availability) {
        const module = analyzed.prepare({ modules: [entry.entryId], presets: [] }).modules[0];
        if (module)
          try {
            await input.availability(module, source);
          } catch (error) {
            const code = error instanceof Error ? error.message : '';
            status = code === 'capability_unsupported' ? 'unsupported' : 'dependency_missing';
            reason =
              status === 'unsupported'
                ? 'capability_unsupported'
                : module.kind === 'camera'
                  ? 'camera_identity_unavailable'
                  : 'dependency_unavailable';
          }
      }
      const copies =
        entry.type === 'module'
          ? (index?.modules[entry.entryId] ?? [])
          : index?.presets[entry.entryId]
            ? [index.presets[entry.entryId]!]
            : [];
      const existing = copies.some((copy) => copy.state === 'existing');
      const removed = copies.length > 0 && !existing;
      return {
        ...entry,
        status:
          status === 'ready'
            ? existing
              ? ('existing' as const)
              : removed
                ? ('removed' as const)
                : status
            : status,
        copies,
        ...(reason ? { reason } : {}),
      };
    }),
  );
  for (const entry of entries)
    if (entry.type === 'preset' && ['ready', 'existing', 'removed'].includes(entry.status)) {
      const unavailable = entry.dependencies
        .map((id) => entries.find((item) => item.entryId === id))
        .find(
          (item) =>
            item &&
            item.status !== 'ready' &&
            item.status !== 'existing' &&
            item.status !== 'removed',
        );
      if (unavailable) {
        entry.status =
          unavailable.status === 'dependency_missing' ? 'dependency_missing' : 'unsupported';
        if (unavailable.reason) entry.reason = unavailable.reason;
      }
    }
  return {
    source,
    name: manifest.name,
    dependencies: manifest.dependencies,
    entries,
    prepare: analyzed.prepare,
  };
}

/** Reinspect the full archive at commit time; save selected drafts without applying them. */
export async function importPresetPack(input: {
  zip: Buffer;
  store: BroadcastConfigStore;
  resources: MusicPackResources;
  selection?: { modules: string[]; presets: string[] };
  expectedDigest?: string;
  availability?: (module: ModuleRecord, source: ResourceRef) => Promise<void>;
}) {
  const inspected = await inspectPresetPack(input);
  if (input.expectedDigest && input.expectedDigest !== inspected.source.digest)
    throw new Error('package_identity_mismatch');
  const selected = input.selection ?? {
    modules: inspected.entries
      .filter((entry) => entry.type === 'module')
      .map((entry) => entry.entryId),
    presets: inspected.entries
      .filter((entry) => entry.type === 'preset')
      .map((entry) => entry.entryId),
  };
  // Validate the complete requested selection before excluding unsupported entries.
  inspected.prepare(selected);
  const allowed = (id: string) => {
    const entry = inspected.entries.find((item) => item.entryId === id);
    return entry && entry.status !== 'unsupported' && entry.status !== 'invalid';
  };
  const reusable = new Set(
    inspected.entries
      .filter(
        (entry) =>
          entry.type === 'module' &&
          selected.modules.includes(entry.entryId) &&
          allowed(entry.entryId) &&
          entry.copies.some((copy) => copy.state === 'existing'),
      )
      .map((entry) => entry.entryId),
  );
  const batch = inspected.prepare({
    modules: selected.modules.filter((id) => allowed(id) && !reusable.has(id)),
    presets: selected.presets.filter(allowed),
  });
  const before = input.store.snapshot;
  const makeEntries = (after: BroadcastConfigDocument) =>
    inspected.entries.map((entry) => ({
      ...entry,
      selected: (entry.type === 'module' ? selected.modules : selected.presets).includes(
        entry.entryId,
      ),
      result: (
        entry.type === 'module'
          ? batch.moduleEntries[entry.entryId]
          : batch.presetEntries[entry.entryId]
      )
        ? (entry.type === 'module' ? after.modules : after.presets).some(
            (item) =>
              item.origin?.entryId === entry.entryId &&
              resourceKey(item.origin.resource) === resourceKey(inspected.source) &&
              !(entry.type === 'module' ? before.modules : before.presets).some(
                (previous) => previous.id === item.id,
              ),
          )
          ? ('imported' as const)
          : ('existing' as const)
        : reusable.has(entry.entryId)
          ? ('existing' as const)
          : (entry.type === 'module' ? selected.modules : selected.presets).includes(entry.entryId)
            ? ('unavailable' as const)
            : ('not_selected' as const),
    }));
  if (!batch.modules.length && !batch.presets.length && !reusable.size)
    return {
      mapping: { source: inspected.source, moduleEntries: {}, presetEntries: {} },
      reused: false,
      entries: makeEntries(before),
    };
  const result = await input.resources.installAndCommit(
    input.zip,
    async (installed) => {
      if (resourceKey(installed) !== resourceKey(inspected.source))
        throw new Error('package_identity_mismatch');
      if (batch.modules.length || batch.presets.length) return input.store.importBatch(batch);
      const index = input.store.inspectImport(installed)!;
      return {
        reused: true,
        mapping: {
          source: installed,
          moduleEntries: Object.fromEntries(
            Object.entries(index.modules).map(([id, copies]) => [
              id,
              copies.map((copy) => copy.id),
            ]),
          ),
          presetEntries: Object.fromEntries(
            Object.entries(index.presets).map(([id, copy]) => [id, copy.id]),
          ),
          moduleOwners: Object.fromEntries(
            Object.values(index.modules)
              .flat()
              .map((copy) => [copy.id, copy.owner]),
          ),
        },
      };
    },
    (ref) => input.store.inspectImport(ref) !== null,
  );
  return { ...result, entries: makeEntries(input.store.snapshot) };
}
