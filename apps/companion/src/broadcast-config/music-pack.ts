import { createHash, randomUUID } from 'node:crypto';
import { MUSIC_GROUPS } from '@mizar/protocol/music';
import {
  parseModuleRecord,
  type AssetRef,
  type ModuleRecord,
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
import type { BroadcastConfigStore } from './store.js';

/** Export one music module and its verified media, without playback or configuration changes. */
export async function exportMusicPack(
  music: MusicStore,
  input: ModuleRecord<'music'>,
  metadata: { packageId: string; version: string; name: string; author: string },
): Promise<Buffer> {
  const module = parseModuleRecord(input);
  if (module.kind !== 'music') throw new Error('package_invalid');
  const assets = new Map<string, { id: string; path: string; bytes: Buffer }>();
  const key = (ref: AssetRef) =>
    JSON.stringify([ref.resource.id, ref.resource.version, ref.resource.digest, ref.fileId]);
  for (const group of MUSIC_GROUPS)
    for (const track of module.value.groups[group].tracks) {
      if (assets.has(key(track.asset))) continue;
      const bytes = await readMusicAsset(music, track.asset);
      const id = `audio-${createHash('sha256').update(bytes).digest('hex')}`;
      const ext = track.asset.fileId.split('.').at(-1)!;
      assets.set(key(track.asset), { id, path: `assets/${id}.${ext}`, bytes });
    }
  const template = exportModule(module, {
    asset(ref) {
      const asset = assets.get(key(ref));
      if (!asset) throw new Error('resource_missing');
      return { package: '$self', fileId: asset.id };
    },
    resource() {
      throw new Error('capability_unsupported');
    },
    tool() {
      throw new Error('capability_unsupported');
    },
  });
  const moduleBytes = Buffer.from(JSON.stringify(template));
  const unique = new Map([...assets.values()].map((asset) => [asset.id, asset]));
  const all = [
    { id: 'music', path: 'modules/music.json', mediaType: 'application/json', bytes: moduleBytes },
    ...[...unique.values()].map((asset) => ({
      ...asset,
      mediaType: `audio/${asset.path.split('.').at(-1)!}`,
    })),
  ];
  const manifest = {
    format: 'mizar.pack',
    formatVersion: 1,
    ...metadata,
    modules: [
      { entryId: 'music', module: 'music', schemaVersion: 1, fileId: 'music', required: true },
    ],
    presets: [],
    dependencies: [],
    requirements: [],
    files: all.map((file) => ({
      id: file.id,
      path: file.path,
      mediaType: file.mediaType,
      bytes: file.bytes.length,
      sha256: createHash('sha256').update(file.bytes).digest('hex'),
    })),
  };
  return writePackArchive(
    Buffer.from(JSON.stringify(manifest)),
    new Map(all.map((file) => [file.path, file.bytes])),
  );
}

/** Provider publishes verified immutable ZIP bytes before a single draft-only config commit. */
export async function importMusicPack(input: {
  zip: Buffer;
  store: BroadcastConfigStore;
  install(archive: Awaited<ReturnType<typeof readPackArchive>>): Promise<ResourceRef>;
}) {
  const archive = await readPackArchive(input.zip);
  const { manifest } = archive;
  if (
    manifest.modules.length !== 1 ||
    manifest.modules[0]?.module !== 'music' ||
    manifest.presets.length ||
    manifest.dependencies.length ||
    manifest.requirements.length
  )
    throw new Error('capability_unsupported');
  for (const file of manifest.files) {
    if (file.id === manifest.modules[0].fileId) {
      if (file.mediaType !== 'application/json' || !file.path.endsWith('.json'))
        throw new Error('package_invalid');
    } else {
      const bytes = archive.files.get(file.path);
      const ext = file.path.split('.').at(-1)?.toLowerCase();
      if (!bytes || file.mediaType !== `audio/${ext}` || !audioBytes(file.path, bytes))
        throw new Error('package_invalid');
    }
  }
  const expected: ResourceRef = {
    id: `local:mizar-pack:${manifest.packageId}`,
    version: manifest.version,
    digest: archive.digest,
  };
  // Validate the domain and references before the provider performs any write.
  const prepare = (source: ResourceRef) =>
    preparePackDrafts({
      manifestBytes: archive.manifestBytes,
      files: archive.files,
      source,
      refs: {
        asset: (ref) => ({ resource: source, fileId: ref.fileId }),
        resource: () => {
          throw new Error('capability_unsupported');
        },
        tool: () => {
          throw new Error('capability_unsupported');
        },
      },
      supports: () => false,
    });
  prepare(expected);
  const installed = await input.install(archive);
  if (
    installed.id !== expected.id ||
    installed.version !== expected.version ||
    installed.digest !== expected.digest
  )
    throw new Error('package_identity_mismatch');
  return input.store.importBatch(prepare(installed));
}

/** Allocate a new package identity for an explicitly new export. */
export function newMusicPackIdentity() {
  return randomUUID();
}
