import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  UpdateManager,
  safeCode,
  updateFailure,
  type UpdateSource,
} from '../src/updates/manager.js';
import type { UpdateManifest } from '../src/updates/contract.js';

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
  await Promise.all(managers.splice(0).map((m) => m.close()));
  await Promise.all(directories.splice(0).map((p) => rm(p, { force: true, recursive: true })));
  vi.useRealTimers();
});
describe('controlled update lifecycle', () => {
  it('distinguishes trust metadata refresh, exhausted API quota and unknown failure without declaring bad signatures', () => {
    const trust = new Error('update_trust_metadata_failed', {
      cause: Object.assign(new Error('metadata refresh timeout'), {
        code: 'TUF_REFRESH_METADATA_ERROR',
      }),
    });
    expect(updateFailure('box_metadata_fallback', trust, 'one').summary).toContain(
      '尚未完成来源认证',
    );
    const quota = Object.assign(new Error('update_network_failed'), {
      status: 403,
      rateLimited: true,
    });
    expect(updateFailure('check', quota, 'one').summary).toContain('访问额度已耗尽');
    expect(safeCode(new Error('unknown original cause'))).toBe('update_operation_failed');
    expect(updateFailure('check', new Error('unknown original cause'), 'one').summary).toContain(
      '原因未知',
    );
  });
  it('retains both source failures with HTTP status and a shared correlation ID outside UI', async () => {
    const log =
      vi.fn<(stage: string, code: string, version?: string, diagnostic?: unknown) => void>();
    const { manager } = await setup({
      log,
      fetcher: () => Promise.resolve(new Response(null, { status: 503 })),
    });
    await manager.check();
    await manager.download();
    await finished(manager);
    const failed = log.mock.calls.filter(
      ([stage]) => stage === 'box_download' || stage === 'github_download',
    );
    expect(failed).toHaveLength(2);
    expect(failed[0]?.[3]).toMatchObject({ error: { status: 503, source: 'box.nju.edu.cn' } });
    expect(failed[1]?.[3]).toMatchObject({ error: { status: 503, source: 'github.com' } });
    const details = failed.map((call) => call[3] as { operationId: string });
    expect(details[0]?.operationId).toMatch(/^[a-f0-9-]{36}$/);
    expect(details[0]?.operationId).toBe(details[1]?.operationId);
    expect(manager.status().error).toBe('update_network_failed');
    expect(JSON.stringify(manager.status())).not.toContain('UpdateRequestError');
  });
  it.each(['installed', 'restored', 'cancelled'])(
    'only shows a completed %s attempt while its resulting payload is still installed',
    async (status) => {
      const { manager, root } = await setup();
      const updates = join(root, 'updates');
      const recoveryDirectory = `install-${'1'.repeat(32)}`;
      await mkdir(join(updates, recoveryDirectory));
      const result = { status, version: '1.1.0', recoveryDirectory };
      await writeFile(join(updates, 'result.json'), JSON.stringify(result));
      const plan = {
        version: '1.1.0',
        contentDigest: status === 'installed' ? 'c'.repeat(64) : 'b'.repeat(64),
        previousContentDigest: status === 'installed' ? 'b'.repeat(64) : 'c'.repeat(64),
      };
      await writeFile(join(updates, recoveryDirectory, 'plan.json'), JSON.stringify(plan));
      await manager.load();
      expect(manager.status().lastResult).toBe(status);

      // A manual install may use the same version number but a different qualified payload.
      const upgraded = new UpdateManager({
        stateRoot: root,
        bundleRoot: join(root, 'program'),
        currentContentDigest: 'd'.repeat(64),
        version: '1.1.0',
        installed: true,
      });
      managers.push(upgraded);
      await upgraded.load();
      expect(upgraded.status().lastResult).toBeNull();
      expect(JSON.parse(await readFile(join(updates, 'result.json'), 'utf8'))).toEqual(result);
      expect(
        JSON.parse(await readFile(join(updates, recoveryDirectory, 'plan.json'), 'utf8')),
      ).toEqual(plan);
    },
  );
  it('keeps unresolved recovery warnings even when the installed payload has changed', async () => {
    const { manager, root } = await setup();
    const recoveryDirectory = `install-${'2'.repeat(32)}`;
    await mkdir(join(root, 'updates', recoveryDirectory));
    await writeFile(
      join(root, 'updates', recoveryDirectory, 'plan.json'),
      JSON.stringify({
        version: '1.1.0',
        contentDigest: 'a'.repeat(64),
        previousContentDigest: 'b'.repeat(64),
      }),
    );
    await writeFile(
      join(root, 'updates/result.json'),
      JSON.stringify({ status: 'recovery-required', version: '1.1.0', recoveryDirectory }),
    );
    await manager.load();
    expect(manager.status().lastResult).toBe('recovery-required');
    await writeFile(
      join(root, 'updates/result.json'),
      JSON.stringify({ status: 'recovery-required', version: 42, recoveryDirectory: null }),
    );
    const restarted = new UpdateManager({
      stateRoot: root,
      bundleRoot: join(root, 'program'),
      currentContentDigest: 'c'.repeat(64),
      version: '1.0.0',
      installed: true,
    });
    managers.push(restarted);
    await restarted.load();
    expect(restarted.status().lastResult).toBe('recovery-required');
  });
  it.each(['missing', 'wrong-version', 'outside-updates'])(
    'keeps the recovery result when its payload cannot be established: %s',
    async (scenario) => {
      const { manager, root } = await setup();
      const recoveryDirectory =
        scenario === 'outside-updates' ? '../outside' : `install-${'3'.repeat(32)}`;
      const directory = join(root, 'updates', recoveryDirectory);
      if (scenario !== 'missing') {
        await mkdir(directory);
        await writeFile(
          join(directory, 'plan.json'),
          JSON.stringify({
            version: scenario === 'wrong-version' ? '1.2.0' : '1.1.0',
            contentDigest: 'a'.repeat(64),
            previousContentDigest: 'b'.repeat(64),
          }),
        );
      }
      await writeFile(
        join(root, 'updates/result.json'),
        JSON.stringify({ status: 'restored', version: '1.1.0', recoveryDirectory }),
      );
      await manager.load();
      expect(manager.status().lastResult).toBe('restored');
    },
  );
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
  it('rejects corrupt bytes and removes partial files before retry', async () => {
    const { manager, root } = await setup({
      fetcher: (input) =>
        Promise.resolve(
          fetchUrl(input).includes('box.nju.edu.cn')
            ? new Response(null, { status: 503 })
            : new Response(Buffer.alloc(bytes.length)),
        ),
    });
    await manager.check();
    await manager.download();
    await finished(manager);
    expect(manager.status()).toMatchObject({ phase: 'error', error: 'update_download_corrupt' });
    expect((await readdir(join(root, 'updates'))).filter((p) => p.startsWith('download-'))).toEqual(
      [],
    );
    await expect(manager.prepare()).rejects.toThrow('update_unavailable');
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
  it('rejects a verified version rollback and a replacement under the same version', async () => {
    let next = manifest;
    const { manager } = await setup({
      source: {
        latest: () => Promise.resolve({ tag_name: `v${next.version}` }),
        authenticate: () => Promise.resolve(next),
      },
    });
    await manager.check();
    next = { ...manifest, notes: '同一版本被替换' };
    await manager.check();
    expect(manager.status().error).toBe('update_identity_changed');
    next = { ...manifest, version: '1.0.1' };
    await manager.check();
    expect(manager.status().error).toBe('update_rollback_rejected');
    await expect(manager.download()).rejects.toThrow('update_unavailable');
  });
  it('never starts an installer for portable builds or incompatible major versions', async () => {
    const { manager } = await setup({ installed: false });
    await manager.check();
    expect(manager.status().phase).toBe('manual');
    await expect(manager.download()).rejects.toThrow();
    const future = {
      ...manifest,
      version: '2.0.0',
      compatibility: { minimumVersion: '2.0.0', maximumVersionExclusive: '3.0.0' },
    };
    const { manager: incompatible } = await setup({
      source: {
        latest: () => Promise.resolve({ tag_name: 'v2.0.0' }),
        authenticate: () => Promise.resolve(future),
      },
    });
    await incompatible.check();
    expect(incompatible.status().phase).toBe('manual');
  });
  it.each([undefined, null, false, true])(
    'keeps stored preference %s and defaults only missing preferences on',
    async (settingsAutomatic) => {
      const { manager } = await setup({ settingsAutomatic });
      expect(manager.status().automatic).toBe(settingsAutomatic !== false);
    },
  );
  it('checks each real launch once, shares manual work and counts failures against six-hour polling', async () => {
    let clock = 5 * 86_400_000;
    const latest = vi.fn(() => Promise.reject(new Error('offline')));
    const log =
      vi.fn<(stage: string, code: string, version?: string, diagnostic?: unknown) => void>();
    const { manager } = await setup({
      source: { latest, authenticate: () => Promise.resolve(manifest) },
      now: () => clock,
      log,
    });
    vi.useFakeTimers();
    manager.start();
    manager.start();
    manager.desktopStartup('launch-one');
    await manager.check();
    await vi.waitFor(() => expect(latest).toHaveBeenCalledTimes(1));
    manager.desktopStartup('launch-one');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(latest).toHaveBeenCalledTimes(1);
    clock += 6 * 60 * 60 * 1000;
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(() => expect(latest).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(manager.status().phase).toBe('error'));
    clock += 1;
    manager.desktopStartup('launch-two');
    await manager.check();
    expect(latest).toHaveBeenCalledTimes(3);
    clock += 3 * 6 * 60 * 60 * 1000;
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(() => expect(latest).toHaveBeenCalledTimes(4));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(latest).toHaveBeenCalledTimes(4);
    expect(manager.status().notificationPending).toBe(false);
    expect(log.mock.calls.map((call) => call[1])).toEqual(
      expect.arrayContaining(['update_check_startup', 'update_check_periodic']),
    );
  });
  it('preserves disabled startup checks and deduplicates reminders until the next real launch', async () => {
    const latest = vi.fn(() => Promise.resolve({ tag_name: 'v1.1.0' }));
    const { manager } = await setup({
      settingsAutomatic: false,
      source: { latest, authenticate: () => Promise.resolve(manifest) },
    });
    manager.desktopStartup('one');
    expect(latest).not.toHaveBeenCalled();
    await manager.check();
    expect(manager.claimNotification('1.1.0')).toBeNull();
    await manager.setAutomatic(true);
    expect(manager.claimNotification('wrong-version')).toBeNull();
    expect(manager.claimNotification('1.1.0')).toEqual({ version: '1.1.0', notes: manifest.notes });
    await manager.check();
    expect(manager.claimNotification('1.1.0')).toBeNull();
    manager.desktopStartup('one');
    expect(manager.claimNotification('1.1.0')).toBeNull();
    manager.desktopStartup('two');
    await manager.check();
    expect(manager.claimNotification('1.1.0')).toEqual({ version: '1.1.0', notes: manifest.notes });
  });
  it('defers startup checks while a download owns the task', async () => {
    const source = {
      latest: vi.fn(() => Promise.resolve({ tag_name: 'v1.1.0' })),
      authenticate: () => Promise.resolve(manifest),
    };
    const { manager } = await setup({
      source,
      fetcher: (_input, options) =>
        new Promise((_resolve, reject) => {
          if (options?.signal?.aborted) {
            reject(new Error('aborted'));
            return;
          }
          options?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          });
        }),
    });
    await manager.check();
    await manager.download();
    manager.desktopStartup('one');
    expect(source.latest).toHaveBeenCalledTimes(1);
    expect(manager.claimNotification('1.1.0')).toBeNull();
    await manager.cancel();
    vi.useFakeTimers();
    manager.start();
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(() => expect(source.latest).toHaveBeenCalledTimes(2));
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
