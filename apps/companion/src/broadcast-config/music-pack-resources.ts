import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, open, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { PACK_LIMITS, readPackArchive } from '@mizar/broadcast-pack';
import type { AssetRef, ResourceRef } from '@mizar/broadcast-config';
import { SerialCommitQueue } from '../match-context/serial-commit.js';
import { ensureDirectory, safePath } from '../resource-store/files.js';
import { audioBytes } from '../music/archive.js';
import type { MusicStore } from '../music/store.js';

/** Immutable local source for music-only share packages; it owns no configuration. */
export class MusicPackResources {
  private readonly queue = new SerialCommitQueue();
  constructor(private readonly root: string) {}
  private filename(id: string, version: string) {
    return `${createHash('sha256')
      .update(JSON.stringify([id, version]))
      .digest('hex')}.mizarpack`;
  }
  private async readStored(name: string) {
    const path = await safePath(this.root, name);
    const before = await lstat(path);
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    let bytes: Buffer;
    try {
      const stat = await handle.stat();
      if (
        !stat.isFile() ||
        stat.nlink !== 1 ||
        stat.dev !== before.dev ||
        stat.ino !== before.ino ||
        stat.size > PACK_LIMITS.total
      )
        throw new Error('resource_damaged');
      bytes = await handle.readFile();
    } finally {
      await handle.close();
    }
    return readPackArchive(bytes);
  }
  private async readArchive(ref: ResourceRef) {
    if (!/^local:mizar-pack:[0-9a-f-]{36}$/i.test(ref.id) || !/^[a-f0-9]{64}$/.test(ref.digest))
      throw new Error('resource_missing');
    const archive = await this.readStored(this.filename(ref.id, ref.version));
    if (
      `local:mizar-pack:${archive.manifest.packageId}` !== ref.id ||
      archive.manifest.version !== ref.version ||
      archive.digest !== ref.digest
    )
      throw new Error('resource_damaged');
    return archive;
  }
  async install(zip: Buffer): Promise<ResourceRef> {
    return this.queue.run(async () => {
      const bytes = Buffer.from(zip);
      const archive = await readPackArchive(bytes);
      const ref = {
        id: `local:mizar-pack:${archive.manifest.packageId}`,
        version: archive.manifest.version,
        digest: archive.digest,
      };
      await ensureDirectory(this.root);
      const filename = this.filename(ref.id, ref.version);
      const target = join(this.root, filename);
      const temporary = join(this.root, `tmp-${randomUUID()}`);
      try {
        const handle = await open(temporary, 'wx', 0o600);
        try {
          await handle.writeFile(bytes);
          await handle.sync();
        } finally {
          await handle.close();
        }
        try {
          await link(temporary, target);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        }
      } finally {
        await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
        });
      }
      try {
        await this.readArchive(ref);
      } catch (error) {
        // An existing same-id/version file with another digest must never be replaced.
        const existing = await this.readStored(filename);
        if (
          `local:mizar-pack:${existing.manifest.packageId}` === ref.id &&
          existing.manifest.version === ref.version &&
          existing.digest !== ref.digest
        )
          throw new Error('identity_conflict', { cause: error });
        throw error;
      }
      return ref;
    });
  }
  async read(ref: AssetRef): Promise<{ name: string; bytes: Buffer }> {
    const archive = await this.readArchive(ref.resource);
    const descriptor = archive.manifest.files.find((file) => file.id === ref.fileId);
    const bytes = descriptor && archive.files.get(descriptor.path);
    const ext = descriptor?.path.split('.').at(-1)?.toLowerCase();
    if (
      !descriptor ||
      !bytes ||
      descriptor.mediaType !== `audio/${ext}` ||
      !audioBytes(descriptor.path, bytes)
    )
      throw new Error('resource_missing');
    return { name: descriptor.path.split('/').at(-1)!, bytes };
  }
  async materialize(ref: AssetRef, music: MusicStore): Promise<string> {
    const asset = await this.read(ref);
    return (await music.add(asset.name, asset.bytes)).id;
  }
}
