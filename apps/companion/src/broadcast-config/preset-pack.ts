import { createHash } from 'node:crypto';
import { MUSIC_GROUPS } from '@mizar/protocol/music';
import {
  boundModules,
  type AssetRef,
  type BroadcastConfigDocument,
  type ResourceRef,
} from '@mizar/broadcast-config';
import {
  exportModule,
  preparePackDrafts,
  readPackArchive,
  writePackArchive,
} from '@mizar/broadcast-pack';
import { audioBytes } from '../music/archive.js';
import type { MusicStore } from '../music/store.js';
import { readMusicAsset } from './music-assets.js';
import type { MusicPackResources } from './music-pack-resources.js';
import type { BroadcastConfigStore } from './store.js';

const resourceKey = (ref: ResourceRef) => JSON.stringify([ref.id, ref.version, ref.digest]);
const assetKey = (ref: AssetRef) => JSON.stringify([resourceKey(ref.resource), ref.fileId]);
type FileEntry = { id: string; path: string; mediaType: string; data: Buffer };

/** Export one complete scheme from a single configuration snapshot. */
export async function exportPresetPack(input: {
  document: BroadcastConfigDocument;
  presetId: string;
  music: MusicStore;
  resources: MusicPackResources;
  metadata: { packageId: string; version: string; name: string; author: string };
}): Promise<Buffer> {
  const preset = input.document.presets.find((item) => item.id === input.presetId);
  if (!preset) throw new Error('preset_missing');
  if (preset.opaqueModules.length) throw new Error('capability_unsupported');
  const bound = boundModules(preset, input.document.modules);
  const audio = new Map<string, { id: string; path: string; data: Buffer }>();
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
  const music = bound.get('music'),
    camera = bound.get('camera');
  if (music?.kind === 'music')
    for (const group of MUSIC_GROUPS)
      for (const track of music.value.groups[group].tracks) await addAudio(track.asset);
  if (camera?.kind === 'camera')
    for (const map of camera.value.maps) {
      if (map.openingSound) await addAudio(map.openingSound.asset);
      // Tool acquisitions need a verified provider mapping before they can be exported.
      throw new Error('capability_unsupported');
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
  const bindingTemplates = preset.bindings.map((binding) =>
    binding.mode === 'off'
      ? binding
      : { kind: binding.kind, mode: 'use' as const, entryId: binding.kind },
  );
  for (const [kind, module] of bound) {
    if (!module) continue;
    const template = exportModule(module, {
      asset(ref) {
        const local = audio.get(assetKey(ref));
        return local
          ? { package: '$self', fileId: local.id }
          : { package: alias(ref.resource), fileId: ref.fileId };
      },
      resource(ref) {
        return { package: alias(ref) };
      },
      tool() {
        throw new Error('capability_unsupported');
      },
    });
    const id = `module-${kind}`;
    entries.push({
      entryId: kind,
      module: kind,
      schemaVersion: module.schemaVersion,
      fileId: id,
      required: true,
    });
    files.push({
      id,
      path: `modules/${kind}.json`,
      mediaType: 'application/json',
      data: Buffer.from(JSON.stringify(template)),
    });
  }
  files.push({
    id: 'preset',
    path: 'presets/main.json',
    mediaType: 'application/json',
    data: Buffer.from(JSON.stringify({ name: preset.name, bindings: bindingTemplates })),
  });
  for (const asset of new Map([...audio.values()].map((item) => [item.id, item])).values())
    files.push({ ...asset, mediaType: `audio/${asset.path.split('.').at(-1)!}` });
  const manifest = {
    format: 'mizar.pack',
    formatVersion: 1,
    ...input.metadata,
    defaultPreset: 'main',
    modules: entries,
    presets: [{ entryId: 'main', schemaVersion: 1, fileId: 'preset' }],
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

/** Validate the package and create drafts; the resource owner publishes before the configuration commit. */
export async function importPresetPack(input: {
  zip: Buffer;
  store: BroadcastConfigStore;
  resources: MusicPackResources;
}) {
  const archive = await readPackArchive(input.zip);
  const { manifest } = archive;
  if (!manifest.presets.length || manifest.dependencies.some((d) => d.delivery.kind !== 'external'))
    throw new Error('capability_unsupported');
  const jsonIds = new Set([...manifest.modules, ...manifest.presets].map((entry) => entry.fileId));
  const audioIds = new Set<string>();
  for (const file of manifest.files) {
    if (jsonIds.has(file.id)) {
      if (file.mediaType !== 'application/json' || !file.path.endsWith('.json'))
        throw new Error('package_invalid');
    } else {
      const bytes = archive.files.get(file.path),
        ext = file.path.split('.').at(-1)?.toLowerCase();
      if (!bytes || file.mediaType !== `audio/${ext}` || !audioBytes(file.path, bytes))
        throw new Error('package_invalid');
      audioIds.add(file.id);
    }
  }
  const source: ResourceRef = {
    id: `local:mizar-pack:${manifest.packageId}`,
    version: manifest.version,
    digest: archive.digest,
  };
  const dependencies = new Map(manifest.dependencies.map((entry) => [entry.alias, entry.resource]));
  const lookup = (alias: string) => {
    const ref = alias === '$self' ? source : dependencies.get(alias);
    if (!ref) throw new Error('dependency_missing');
    return ref;
  };
  const prepare = () =>
    preparePackDrafts({
      manifestBytes: archive.manifestBytes,
      files: archive.files,
      source,
      refs: {
        asset(ref) {
          if (ref.package === '$self' && !audioIds.has(ref.fileId))
            throw new Error('resource_missing');
          return { resource: lookup(ref.package), fileId: ref.fileId };
        },
        resource(ref) {
          return lookup(ref.package);
        },
        tool() {
          throw new Error('capability_unsupported');
        },
      },
      supports: () => false,
    });
  const batch = prepare();
  const installed = await input.resources.install(input.zip);
  if (resourceKey(installed) !== resourceKey(source)) throw new Error('package_identity_mismatch');
  return input.store.importBatch(batch);
}
