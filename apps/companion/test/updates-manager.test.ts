import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UpdateManager, type UpdateSource } from '../src/updates/manager.js';
import type { UpdateManifest } from '../src/updates/contract.js';

vi.mock('node:fs/promises', { spy: true });

const bytes = Buffer.from('independent qualified installer fixture');
const manifest: UpdateManifest = {
  schemaVersion: 'mizar.update.v1',
  repository: 'Starfie1d1272/Mizar',
  channel: 'stable',
  version: '1.1.0',
  gitSha: 'a'.repeat(40),
  notes: '完整中文更新说明',
  compatibility: { minimumVersion: '1.0.0', maximumVersionExclusive: '2.0.0' },
  installer: {
    platform: 'win32-x64',
    format: 'nsis-setup',
    name: 'Mizar-v1.1.0-Windows-x64-Setup.exe',
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    contentDigest: 'b'.repeat(64),
  },
};
const directories: string[] = [];
const managers: UpdateManager[] = [];
const fetchUrl = (input: Parameters<typeof fetch>[0]) =>
  input instanceof Request ? input.url : input instanceof URL ? input.href : input;
async function setup({
  installed = true,
  source,
  fetcher,
  now,
  log,
  settingsAutomatic,
}: {
  installed?: boolean;
  source?: UpdateSource;
  fetcher?: typeof fetch;
  now?: () => number;
  log?: (stage: string, code: string, version?: string, diagnostic?: unknown) => void;
  settingsAutomatic?: boolean | null | undefined;
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'mizar-update-'));
  directories.push(root);
  const authority = source ?? {
    latest: vi.fn(() => Promise.resolve({ tag_name: 'v1.1.0' })),
    authenticate: vi.fn(() => Promise.resolve(manifest)),
  };
  const manager = new UpdateManager({
    stateRoot: root,
    bundleRoot: join(root, 'program'),
    currentContentDigest: 'c'.repeat(64),
    version: '1.0.0',
    installed,
    source: authority,
    fetcher:
      fetcher ??
      ((input) =>
        Promise.resolve(
          fetchUrl(input).includes('box.nju.edu.cn')
            ? new Response(null, { status: 503 })
            : new Response(bytes),
        )),
    ...(now ? { now } : {}),
    ...(log ? { log } : {}),
  });
  managers.push(manager);
  if (settingsAutomatic !== undefined) {
    await mkdir(join(root, 'updates'));
    await writeFile(
      join(root, 'updates/settings.json'),
      JSON.stringify({
        ...(settingsAutomatic === null ? {} : { automatic: settingsAutomatic }),
        lastAttempt: 0,
        highestVersion: null,
        highestIdentity: null,
      }),
    );
  }
  await manager.load();
  return { manager, root, source: authority };
}
async function finished(manager: UpdateManager) {
  await vi.waitFor(() => expect(manager.status().phase).not.toBe('downloading'));
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(managers.splice(0).map((m) => m.close()));
  await Promise.all(directories.splice(0).map((p) => rm(p, { force: true, recursive: true })));
  vi.useRealTimers();
});
describe('controlled update lifecycle', () => {
  it('falls back to identical GitHub bytes, keeps a ready download across restart and rechecks before preparing', async () => {
    const { manager, root, source } = await setup();
    await manager.check();
    await manager.download();
    await finished(manager);
    expect(manager.status().phase).toBe('ready');
    const ready = JSON.parse(await readFile(join(root, 'updates/ready.json'), 'utf8')) as {
      directory: string;
    };
    expect(await readFile(join(root, 'updates', ready.directory, manifest.installer.name))).toEqual(
      bytes,
    );
    const restored = new UpdateManager({
      stateRoot: root,
      bundleRoot: join(root, 'program'),
      currentContentDigest: 'c'.repeat(64),
      version: '1.0.0',
      installed: true,
      source,
    });
    managers.push(restored);
    await restored.load();
    expect(restored.status().phase).toBe('idle');
    await restored.check();
    expect(restored.status().phase).toBe('ready');
    const plan = await restored.prepare();
    expect(plan).toMatchObject({
      version: '1.1.0',
      installerSha256: manifest.installer.sha256,
      previousContentDigest: 'c'.repeat(64),
    });
    await expect(restored.cancel()).rejects.toThrow('update_busy');
    restored.release();
    expect(restored.status().phase).toBe('ready');
  });
  it('cancels an active stream and never offers its partially written installer', async () => {
    let started = false;
    const { manager, root } = await setup({
      fetcher: (input, options) => {
        if (fetchUrl(input).includes('box.nju.edu.cn'))
          return Promise.resolve(new Response(null, { status: 503 }));
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            started = true;
            controller.enqueue(bytes.subarray(0, 3));
            options?.signal?.addEventListener(
              'abort',
              () => controller.error(new Error('aborted')),
              { once: true },
            );
          },
        });
        return Promise.resolve(new Response(stream));
      },
    });
    await manager.check();
    await manager.download();
    await vi.waitFor(() => expect(started).toBe(true));
    await manager.cancel();
    expect(manager.status()).toMatchObject({ phase: 'available', error: 'update_cancelled' });
    expect((await readdir(join(root, 'updates'))).filter((p) => p.startsWith('download-'))).toEqual(
      [],
    );
  });
  it('detects post-download tampering on installation recheck', async () => {
    const { manager, root } = await setup();
    await manager.check();
    await manager.download();
    await finished(manager);
    const ready = JSON.parse(await readFile(join(root, 'updates/ready.json'), 'utf8')) as {
      directory: string;
    };
    await writeFile(join(root, 'updates', ready.directory, manifest.installer.name), 'corrupt');
    await expect(manager.prepare()).rejects.toThrow('update_recheck_required');
    expect(manager.status().phase).toBe('available');
  });
});
