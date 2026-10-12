import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PreparePack, StoreOptions, TrustedPack } from '../../src/resource-store/contract.js';
import { checkDescriptor, verifiedRead } from '../../src/resource-store/files.js';
import { ResourceStore } from '../../src/resource-store/store.js';

const packId = 'official:epl-default';
const hash = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const fixture = (version: string, data = '0123456789'): TrustedPack => ({
  packId,
  packVersion: version,
  compatible: true,
  files: [{ path: 'replay/video.mp4', bytes: Buffer.byteLength(data), sha256: hash(data) }],
});
const roots: string[] = [];
const stores: ResourceStore[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function setup(overrides: Partial<StoreOptions> = {}) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'mizar-resources-'));
  roots.push(root);
  // Deliberately fake authorization boundary: only these independent known fixtures are trusted.
  const approved = new Map([
    ['v1', fixture('1')],
    ['v2', fixture('2', 'abcdefghij')],
  ]);
  const verifier = vi.fn(({ receipt }: { receipt: unknown }) => {
    const descriptor = approved.get(receipt as string);
    if (!descriptor) throw new Error('untrusted receipt');
    return Promise.resolve(structuredClone(descriptor));
  });
  const options: StoreOptions = {
    root,
    verifyTrustedPack: verifier,
    activateWhenSafe: async (commit) => {
      await commit();
      return true;
    },
    ...overrides,
  };
  const store = await ResourceStore.open(options);
  stores.push(store);
  return { root, store, options, verifier };
}
const prepare =
  (receipt = 'v1', data = '0123456789'): PreparePack =>
  async ({ directory, onProgress }) => {
    await mkdir(join(directory, 'replay'));
    await writeFile(join(directory, 'replay/video.mp4'), data);
    onProgress(Buffer.byteLength(data));
    return receipt;
  };

describe('Resource Store', () => {
  it('cancels and rejects concurrent operations/writers while preserving old ready bytes', async () => {
    const { store, options } = await setup();
    await store.installVerified(packId, prepare());
    await expect(ResourceStore.open(options)).rejects.toThrow('resource_store_locked');
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const pending = store.repair(packId, async ({ signal }) => {
      started();
      await new Promise<void>((_resolve, reject) =>
        signal.addEventListener(
          'abort',
          () => reject(new DOMException('Cancelled', 'AbortError')),
          { once: true },
        ),
      );
      return 'v2';
    });
    await ready;
    await expect(store.repair(packId, prepare())).rejects.toThrow('resource_operation_conflict');
    store.cancel(packId);
    await expect(pending).rejects.toThrow();
    expect(store.getStatus(packId)).toMatchObject({
      phase: 'failed',
      failure: 'resource_cancelled',
      activeVersion: '1',
    });
    expect((await store.read(packId, 'replay/video.mp4')).bytes.toString()).toBe('0123456789');
  });

  it('recovers the verified previous version when the activated version loses content after an interruption', async () => {
    const { store, options } = await setup();
    await store.installVerified(packId, prepare());
    await store.installVerified(packId, prepare('v2', 'abcdefghij'), { packVersion: '2' });
    const damaged = await store.resolveReadOnlyPath(packId, 'replay/video.mp4');
    await rm(damaged);
    await store.close();
    const restored = await ResourceStore.open(options);
    stores.push(restored);
    expect(restored.getStatus(packId)).toMatchObject({ phase: 'failed', activeVersion: '1' });
    expect((await restored.read(packId, 'replay/video.mp4')).bytes.toString()).toBe('0123456789');
  });

  it('enforces paths, types, sizes and link rejection at the store boundary', async () => {
    for (const path of [
      '../secret.json',
      '/secret.json',
      'C:/secret.json',
      'replay\\video.mp4',
      'a/../secret.json',
      'CON.json',
      'secret.json ',
      'payload.js',
    ]) {
      expect(() =>
        checkDescriptor(
          { ...fixture('1'), files: [{ path, bytes: 10, sha256: hash('0123456789') }] },
          packId,
        ),
      ).toThrow();
    }
    expect(() =>
      checkDescriptor(
        {
          ...fixture('1'),
          files: [fixture('1').files[0]!, { ...fixture('1').files[0]!, path: 'REPLAY/VIDEO.mp4' }],
        },
        packId,
      ),
    ).toThrow();
    expect(() =>
      checkDescriptor(
        { ...fixture('1'), files: [{ ...fixture('1').files[0]!, bytes: 1024 ** 3 }] },
        packId,
      ),
    ).toThrow();
    const { root, store } = await setup();
    const outside = join(root, 'outside.mp4');
    await writeFile(outside, '0123456789');
    await expect(
      store.installVerified(packId, async ({ directory }) => {
        await mkdir(join(directory, 'replay'));
        await symlink(outside, join(directory, 'replay/video.mp4'));
        return 'v1';
      }),
    ).rejects.toThrow('resource_path_unsafe');
    expect(store.getStatus(packId).activeVersion).toBeNull();
  });

  it('refuses a file changed after validation starts, including same-sized content', async () => {
    const root = await mkdtemp(join(await realpath(tmpdir()), 'mizar-toctou-'));
    roots.push(root);
    const data = Buffer.alloc(128 * 1024, 42);
    const path = join(root, 'video.mp4');
    await writeFile(path, data);
    let changed = false;
    await expect(
      verifiedRead(
        root,
        { path: 'video.mp4', bytes: data.length, sha256: hash(data) },
        new AbortController().signal,
        async () => {
          if (!changed) {
            changed = true;
            await writeFile(path, Buffer.alloc(data.length, 43));
          }
        },
      ),
    ).rejects.toThrow('resource_integrity_failed');
  });
});
