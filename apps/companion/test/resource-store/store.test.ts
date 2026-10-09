import { createHash } from 'node:crypto';
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PreparePack, StoreOptions, TrustedPack } from '../../src/resource-store/contract.js';
import { checkDescriptor, verifiedRead } from '../../src/resource-store/files.js';
import { registerResourceRoutes } from '../../src/resource-store/routes.js';
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
  it('persists a verified independent cache; restart/cache hits do not invoke the downloader', async () => {
    const { root, store, options, verifier } = await setup();
    expect(store.getStatus(packId).phase).toBe('missing');
    await store.installVerified(packId, prepare());
    const bundledPath = await store.resolveReadOnlyPath(packId, 'replay/video.mp4');
    expect(bundledPath.startsWith(root)).toBe(true);
    await store.close();
    const restored = await ResourceStore.open(options);
    stores.push(restored);
    const download = vi.fn(() => Promise.reject(new Error('network must stay unused')));
    expect(await restored.installVerified(packId, download)).toMatchObject({
      phase: 'ready',
      activeVersion: '1',
    });
    expect(download).not.toHaveBeenCalled();
    expect(verifier).toHaveBeenCalled();
    expect((await restored.read(packId, 'replay/video.mp4')).bytes.toString()).toBe('0123456789');
  });

  it('keeps the active version on bad hashes, untrusted sources, wrong versions and incompatible packs', async () => {
    const { store } = await setup();
    await store.installVerified(packId, prepare());
    for (const [candidate, version, reason] of [
      [prepare('v2', 'XXXXXXXXXX'), '2', 'resource_integrity_failed'],
      [prepare('v2', 'a'), '2', 'resource_file_changed'],
      [prepare('attacker'), '2', 'resource_trust_failed'],
      [prepare('v2', 'abcdefghij'), '3', 'resource_version_mismatch'],
    ] as const) {
      await expect(store.repair(packId, candidate, { packVersion: version })).rejects.toThrow(
        reason,
      );
      expect(store.getStatus(packId)).toMatchObject({ phase: 'failed', activeVersion: '1' });
      expect((await store.read(packId, 'replay/video.mp4')).bytes.toString()).toBe('0123456789');
    }
    const { store: incompatible } = await setup({
      verifyTrustedPack: () => Promise.resolve({ ...fixture('1'), compatible: false }),
    });
    await expect(incompatible.installVerified(packId, prepare())).rejects.toThrow(
      'resource_incompatible',
    );
    expect(incompatible.getStatus(packId).phase).toBe('incompatible');
  });

  it('only prepares during live production, then activates within the integration lease', async () => {
    let live = false;
    const { store, options } = await setup({
      activateWhenSafe: async (commit) => {
        if (live) return false;
        await commit();
        return true;
      },
    });
    await store.installVerified(packId, prepare());
    live = true;
    await store.installVerified(packId, prepare('v2', 'abcdefghij'), { packVersion: '2' });
    expect(store.getStatus(packId)).toMatchObject({
      phase: 'ready',
      activeVersion: '1',
      preparedVersion: '2',
    });
    expect((await store.read(packId, 'replay/video.mp4')).bytes.toString()).toBe('0123456789');
    expect(await store.activatePrepared(packId)).toBe(false);
    const download = vi.fn(() => Promise.reject(new Error('prepared cache must not redownload')));
    await store.installVerified(packId, download, { packVersion: '2' });
    expect(download).not.toHaveBeenCalled();
    await store.close();
    const restored = await ResourceStore.open(options);
    stores.push(restored);
    expect(restored.getStatus(packId)).toMatchObject({ activeVersion: '1', preparedVersion: '2' });
    live = false;
    expect(await restored.activatePrepared(packId)).toBe(true);
    expect((await restored.read(packId, 'replay/video.mp4')).bytes.toString()).toBe('abcdefghij');
    expect(restored.getStatus(packId).rollbackVersion).toBe('1');
    live = true;
    expect(await restored.rollback(packId)).toBe(false);
    live = false;
    expect(await restored.rollback(packId)).toBe(true);
    expect((await restored.read(packId, 'replay/video.mp4')).bytes.toString()).toBe('0123456789');
  });

  it('fails closed without a production activation lease and forbids removal of required materials', async () => {
    const { options, store: initial } = await setup();
    await initial.close();
    delete options.activateWhenSafe;
    const store = await ResourceStore.open(options);
    stores.push(store);
    await store.installVerified(packId, prepare());
    expect(store.getStatus(packId)).toMatchObject({ activeVersion: null, preparedVersion: '1' });
    await expect(store.read(packId, 'replay/video.mp4')).rejects.toThrow('resource_not_ready');
    await expect(store.removeOptional(packId)).rejects.toThrow('resource_pack_required');
  });

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

  it('rejects corrupt cache on reads/restart and recovers abandoned staging plus dead writer leases', async () => {
    const { root, store, options } = await setup();
    await store.installVerified(packId, prepare());
    const path = await store.resolveReadOnlyPath(packId, 'replay/video.mp4');
    await chmod(path, 0o600);
    await writeFile(path, 'XXXXXXXXXX');
    await expect(store.read(packId, 'replay/video.mp4')).rejects.toThrow(
      'resource_integrity_failed',
    );
    await store.close();
    const directory = dirname(dirname(dirname(dirname(dirname(path)))));
    await mkdir(join(directory, 'staging', 'abandoned'));
    await writeFile(join(directory, 'staging', 'abandoned', 'partial.mp4'), 'broken');
    await mkdir(join(root, 'writers', '2147483647-00000000-0000-0000-0000-000000000000'));
    const restored = await ResourceStore.open(options);
    stores.push(restored);
    expect(restored.getStatus(packId)).toMatchObject({ phase: 'failed', activeVersion: null });
    expect(await readdir(join(directory, 'staging'))).toEqual([]);
    await restored.repair(packId, prepare());
    expect((await restored.read(packId, 'replay/video.mp4')).bytes.toString()).toBe('0123456789');
  });

  it('migrates old bundled materials into a private copy without altering their bytes', async () => {
    const { root, store } = await setup({
      verifyTrustedPack: ({ purpose }) => {
        if (purpose === 'install')
          return Promise.reject(
            new Error('legacy authorization must not become new-install authorization'),
          );
        return Promise.resolve(fixture('1'));
      },
    });
    const legacy = join(root, 'legacy');
    await mkdir(legacy);
    await prepare()({
      directory: legacy,
      signal: new AbortController().signal,
      onProgress: () => {},
    });
    await store.reuseLegacy(packId, { directory: legacy, receipt: 'v1' });
    const destination = await store.resolveReadOnlyPath(packId, 'replay/video.mp4');
    expect(destination).not.toBe(join(legacy, 'replay/video.mp4'));
    expect(await readFile(join(legacy, 'replay/video.mp4'), 'utf8')).toBe('0123456789');
  });

  it('retains failure/progress on restart and clears it only after a successful local cache check', async () => {
    const { store, options } = await setup();
    await store.installVerified(packId, prepare());
    await expect(
      store.repair(packId, prepare('v2', 'XXXXXXXXXX'), { packVersion: '2' }),
    ).rejects.toThrow('resource_integrity_failed');
    await store.close();
    const restored = await ResourceStore.open(options);
    stores.push(restored);
    expect(restored.getStatus(packId)).toMatchObject({
      phase: 'failed',
      activeVersion: '1',
      downloadedBytes: 10,
      failure: 'resource_integrity_failed',
    });
    await restored.installVerified(packId, () => Promise.reject(new Error('no network')));
    await restored.close();
    const checked = await ResourceStore.open(options);
    stores.push(checked);
    expect(checked.getStatus(packId)).toMatchObject({
      phase: 'ready',
      activeVersion: '1',
      downloadedBytes: 10,
      failure: null,
    });
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

  it('removes optional content only behind the same safe activation guard', async () => {
    let blocked = false;
    const { store, options } = await setup({
      packs: [{ packId, optional: true }],
      activateWhenSafe: async (commit) => {
        if (blocked) return false;
        await commit();
        return true;
      },
    });
    await store.installVerified(packId, prepare());
    blocked = true;
    await expect(store.removeOptional(packId)).rejects.toThrow('resource_activation_blocked');
    expect((await store.read(packId, 'replay/video.mp4')).bytes.toString()).toBe('0123456789');
    blocked = false;
    expect(await store.removeOptional(packId)).toMatchObject({
      phase: 'missing',
      activeVersion: null,
    });
    await store.close();
    const restored = await ResourceStore.open(options);
    stores.push(restored);
    expect(restored.getStatus(packId)).toMatchObject({ phase: 'missing', downloadedBytes: 0 });
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

  it('serves readonly HTTP bytes, video ranges and safe errors via the injected existing Fastify service', async () => {
    const { store } = await setup();
    await store.installVerified(packId, prepare());
    const app = Fastify();
    registerResourceRoutes(app, store);
    try {
      const base = '/local/v1/resources/official%3Aepl-default';
      const head = await app.inject({
        method: 'HEAD',
        url: `${base}/files/replay/video.mp4`,
        headers: { range: 'bytes=2-5' },
      });
      expect(head.statusCode).toBe(200);
      expect(head.body).toBe('');
      expect(head.headers['content-length']).toBe('10');
      expect((await app.inject(`${base}`)).json()).toMatchObject({
        phase: 'ready',
        activeVersion: '1',
      });
      for (const [range, expected, contentRange] of [
        ['bytes=2-5', '2345', 'bytes 2-5/10'],
        ['bytes=-3', '789', 'bytes 7-9/10'],
        ['bytes=7-', '789', 'bytes 7-9/10'],
      ]) {
        const response = await app.inject({
          url: `${base}/files/replay/video.mp4`,
          headers: { range: range! },
        });
        expect(response.statusCode).toBe(206);
        expect(response.body).toBe(expected);
        expect(response.headers['content-range']).toBe(contentRange);
        expect(response.headers['content-type']).toBe('video/mp4');
        expect(response.headers['x-content-type-options']).toBe('nosniff');
      }
      for (const range of ['bytes=10-', 'bytes=3-2', 'bytes=0-1,4-5', 'bytes=-0']) {
        const response = await app.inject({
          url: `${base}/files/replay/video.mp4`,
          headers: { range },
        });
        expect(response.statusCode).toBe(416);
        expect(response.headers['content-range']).toBe('bytes */10');
      }
      expect((await app.inject(`${base}/files/%2e%2e/secret.json`)).statusCode).toBe(404);
      expect(
        (await app.inject('/local/v1/resources/unknown/files/replay/video.mp4')).statusCode,
      ).toBe(404);
      expect(
        (await app.inject({ method: 'POST', url: base, payload: { path: '/etc/passwd' } }))
          .statusCode,
      ).toBe(404);
    } finally {
      await app.close();
    }
  });
});
