import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, open, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { crc32 } from 'node:zlib';
import { PACK_LIMITS, readPackArchive } from '@mizar/broadcast-pack';
import type { AssetRef, ResourceRef } from '@mizar/broadcast-config';
import { SerialCommitQueue } from '../match-context/serial-commit.js';
import { ensureDirectory, safePath } from '../resource-store/files.js';
import { audioBytes } from '../music/archive.js';
import type { MusicStore } from '../music/store.js';

/** Inspect raster headers before serving bytes; SVG and other active content are unsupported. */
export function validPackImage(bytes: Buffer, mediaType: string): boolean {
  if (bytes.length > 10 * 1024 * 1024) return false;
  let width = 0,
    height = 0;
  if (
    mediaType === 'image/png' &&
    bytes.length >= 45 &&
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    bytes.readUInt32BE(8) === 13 &&
    bytes.toString('ascii', 12, 16) === 'IHDR'
  ) {
    let offset = 8;
    let imageData = false,
      end = false;
    while (offset + 12 <= bytes.length) {
      const length = bytes.readUInt32BE(offset);
      if (length > bytes.length - offset - 12) return false;
      if (
        crc32(bytes.subarray(offset + 4, offset + 8 + length)) !==
        bytes.readUInt32BE(offset + 8 + length)
      )
        return false;
      const type = bytes.toString('ascii', offset + 4, offset + 8);
      if (type === 'IDAT') imageData = true;
      offset += length + 12;
      if (type === 'IEND') {
        end = length === 0 && offset === bytes.length;
        break;
      }
    }
    if (!imageData || !end) return false;
    width = bytes.readUInt32BE(16);
    height = bytes.readUInt32BE(20);
  } else if (
    mediaType === 'image/jpeg' &&
    bytes.length >= 4 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes.at(-2) === 0xff &&
    bytes.at(-1) === 0xd9
  ) {
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset] !== 0xff) break;
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++]!;
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > bytes.length) break;
      const length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length) break;
      if (
        [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(
          marker,
        ) &&
        length >= 7
      ) {
        height = bytes.readUInt16BE(offset + 3);
        width = bytes.readUInt16BE(offset + 5);
        break;
      }
      offset += length;
    }
  } else if (
    mediaType === 'image/webp' &&
    bytes.length >= 30 &&
    bytes.toString('ascii', 0, 4) === 'RIFF' &&
    bytes.toString('ascii', 8, 12) === 'WEBP' &&
    bytes.readUInt32LE(4) + 8 === bytes.length
  ) {
    const chunk = bytes.toString('ascii', 12, 16);
    if (chunk === 'VP8X') {
      width = bytes.readUIntLE(24, 3) + 1;
      height = bytes.readUIntLE(27, 3) + 1;
    } else if (chunk === 'VP8 ' && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
      width = bytes.readUInt16LE(26) & 0x3fff;
      height = bytes.readUInt16LE(28) & 0x3fff;
    } else if (chunk === 'VP8L' && bytes[20] === 0x2f) {
      const bits = bytes.readUInt32LE(21);
      width = (bits & 0x3fff) + 1;
      height = ((bits >>> 14) & 0x3fff) + 1;
    }
  }
  return width > 0 && height > 0 && width <= 8192 && height <= 8192 && width * height <= 32_000_000;
}

/** Immutable local source for share-package assets; it owns no configuration. */
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
    let archive: Awaited<ReturnType<MusicPackResources['readStored']>>;
    try {
      archive = await this.readStored(this.filename(ref.id, ref.version));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        throw new Error('resource_missing', { cause: error });
      throw new Error('resource_damaged', { cause: error });
    }
    if (
      `local:mizar-pack:${archive.manifest.packageId}` !== ref.id ||
      archive.manifest.version !== ref.version ||
      archive.digest !== ref.digest
    )
      throw new Error('resource_damaged');
    return archive;
  }
  async install(zip: Buffer): Promise<ResourceRef> {
    return this.installAndCommit(zip, async (ref) => ref);
  }
  /** Serialize installation through the configuration commit with explicit removal. */
  async installAndCommit<T>(zip: Buffer, commit: (ref: ResourceRef) => Promise<T>): Promise<T> {
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
      if (await this.isDeleting(ref)) throw new Error('resource_deleting');
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
      return commit(ref);
    });
  }
  async isDeleting(ref: ResourceRef): Promise<boolean> {
    try {
      await lstat(join(this.root, `${this.filename(ref.id, ref.version)}.deleting`));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }
  /** The caller's reference guard serializes the last reference check and deletion mark. */
  async remove(
    ref: ResourceRef,
    guard: <T>(operation: () => Promise<T>) => Promise<T>,
    referenced: () => ResourceRef[],
  ): Promise<void> {
    await this.queue.run(() =>
      guard(async () => {
        const marker = join(this.root, `${this.filename(ref.id, ref.version)}.deleting`);
        if (
          referenced().some(
            (item) =>
              item.id === ref.id && item.version === ref.version && item.digest === ref.digest,
          )
        )
          throw new Error('resource_in_use');
        if (await this.isDeleting(ref)) {
          const handle = await open(marker, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
          let saved: ResourceRef;
          try {
            const stat = await handle.stat();
            if (!stat.isFile() || stat.nlink !== 1 || stat.size > 1024)
              throw new Error('resource_damaged');
            saved = JSON.parse(await handle.readFile('utf8')) as ResourceRef;
          } finally {
            await handle.close();
          }
          if (saved.id !== ref.id || saved.version !== ref.version || saved.digest !== ref.digest)
            throw new Error('resource_deleting');
        } else {
          await this.readArchive(ref);
          const temporary = join(this.root, `tmp-${randomUUID()}`);
          try {
            const handle = await open(temporary, 'wx', 0o600);
            try {
              await handle.writeFile(JSON.stringify(ref));
              await handle.sync();
            } finally {
              await handle.close();
            }
            await rename(temporary, marker);
          } finally {
            await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
              if (error.code !== 'ENOENT') throw error;
            });
          }
        }
        await unlink(join(this.root, this.filename(ref.id, ref.version))).catch(
          (error: NodeJS.ErrnoException) => {
            if (error.code !== 'ENOENT') throw error;
          },
        );
        await unlink(marker);
      }),
    );
  }
  async read(ref: AssetRef): Promise<{ name: string; bytes: Buffer }> {
    const asset = await this.readAsset(ref);
    if (!asset.mediaType.startsWith('audio/')) throw new Error('resource_unsupported');
    return asset;
  }
  async readAsset(ref: AssetRef): Promise<{ name: string; bytes: Buffer; mediaType: string }> {
    const archive = await this.readArchive(ref.resource);
    const descriptor = archive.manifest.files.find((file) => file.id === ref.fileId);
    const bytes = descriptor && archive.files.get(descriptor.path);
    const ext = descriptor?.path.split('.').at(-1)?.toLowerCase();
    if (!descriptor || !bytes) throw new Error('resource_missing');
    if (descriptor.mediaType.startsWith('audio/')) {
      if (descriptor.mediaType !== `audio/${ext}` || !audioBytes(descriptor.path, bytes))
        throw new Error('resource_damaged');
    } else if (['image/png', 'image/jpeg', 'image/webp'].includes(descriptor.mediaType)) {
      if (!validPackImage(bytes, descriptor.mediaType)) throw new Error('resource_damaged');
    } else throw new Error('resource_unsupported');
    return { name: descriptor.path.split('/').at(-1)!, bytes, mediaType: descriptor.mediaType };
  }
  async materialize(ref: AssetRef, music: MusicStore): Promise<string> {
    const asset = await this.read(ref);
    return (await music.add(asset.name, asset.bytes)).id;
  }
}
