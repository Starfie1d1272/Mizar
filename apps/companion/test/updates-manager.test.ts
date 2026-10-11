import * as fs from 'node:fs/promises';
import { buildApp } from '../src/app.js';
import { UpdateRequestError } from '../src/updates/diagnostics.js';
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

vi.mock('node:fs/promises', { spy: true });

const productRuntime = {
  artifactSha256: 'a'.repeat(64),
  gitSha: 'b'.repeat(40),
  instanceId: 'test',
  controlToken: 'private-test-token',
  stop: () => {},
};

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
  it('isolates a blocked update directory while the main app and status remain available', async () => {
    const latest = vi.fn(() => Promise.resolve({ tag_name: 'v1.1.0' }));
    const { manager, root } = await setup({
      source: { latest, authenticate: () => Promise.resolve(manifest) },
    });
    await rm(join(root, 'updates'), { recursive: true });
    await writeFile(join(root, 'updates'), 'preserved local record');
    await expect(manager.load()).resolves.toBeUndefined();
    expect(manager.status()).toMatchObject({
      phase: 'error',
      error: 'update_initialization_failed',
      candidate: null,
    });
    expect(manager.status().failureDetails.at(-1)).toMatchObject({
      stage: 'directory_load',
      stageLabel: '初始化更新目录',
    });
    for (const operation of [
      () => manager.check(),
      () => manager.download(),
      () => manager.prepare(),
      () => manager.cancel(),
      () => manager.setAutomatic(false),
    ]) {
      await expect(operation()).rejects.toThrow('update_initialization_failed');
    }
    manager.desktopStartup(`${'a'.repeat(32)}-${'b'.repeat(8)}`);
    await Promise.resolve();
    expect(latest).not.toHaveBeenCalled();
    expect(await readFile(join(root, 'updates'), 'utf8')).toBe('preserved local record');
    const app = buildApp({ updates: manager, productRuntime });
    try {
      expect((await app.inject('/health')).statusCode).toBe(200);
      const status = await app.inject('/local/v1/updates');
      expect(status.statusCode).toBe(200);
      expect(status.json()).toMatchObject({
        phase: 'error',
        error: 'update_initialization_failed',
      });
    } finally {
      await app.close();
    }
  });

  it.each(['directory_scan', 'download_cleanup'])(
    'retains recovery records and the sanitized IO cause when %s fails',
    async (stage) => {
      const log =
        vi.fn<(stage: string, code: string, version?: string, diagnostic?: unknown) => void>();
      const { manager, root } = await setup({ log });
      const recovery = JSON.stringify({ status: 'recovery-required' });
      await writeFile(join(root, 'updates/result.json'), recovery);
      await mkdir(join(root, 'updates/download-orphan'));
      const cause = Object.assign(new Error('EACCES /home/private-user/updates'), {
        code: 'EACCES',
      });
      if (stage === 'directory_scan') vi.spyOn(fs, 'readdir').mockRejectedValueOnce(cause);
      else vi.spyOn(fs, 'rm').mockRejectedValueOnce(cause);
      await expect(manager.load()).resolves.toBeUndefined();
      expect(manager.status()).toMatchObject({
        phase: 'error',
        error: 'update_initialization_failed',
        lastResult: 'recovery-required',
      });
      expect(manager.status().failureDetails.at(-1)).toMatchObject({ stage });
      const logged = log.mock.calls.find(([value]) => value === stage);
      expect(logged?.slice(0, 3)).toEqual([stage, 'update_initialization_failed', undefined]);
      expect(logged?.[3]).toMatchObject({
        error: { cause: { code: 'EACCES', message: 'EACCES /home/[user]/updates' } },
      });
      expect(await readFile(join(root, 'updates/result.json'), 'utf8')).toBe(recovery);
      expect(await readdir(join(root, 'updates'))).toContain('download-orphan');
      await expect(manager.prepare()).rejects.toThrow('update_initialization_failed');
    },
  );

  it('returns this installation recheck cause through HTTP and clears it before a later check', async () => {
    const source = {
      latest: vi.fn<UpdateSource['latest']>(() => Promise.resolve({ tag_name: 'v1.1.0' })),
      authenticate: vi.fn(() => Promise.resolve(manifest)),
    };
    const { manager } = await setup({ source });
    await manager.check();
    await manager.download();
    await finished(manager);
    const quota = new UpdateRequestError('update_network_failed', 'api.github.com', 403);
    quota.rateLimited = true;
    source.authenticate.mockRejectedValueOnce(quota);
    const app = buildApp({
      updates: manager,
      productRuntime: {
        artifactSha256: 'a'.repeat(64),
        gitSha: 'b'.repeat(40),
        instanceId: 'test',
        controlToken: 'private-test-token',
        stop: () => {},
      },
    });
    try {
      const reply = await app.inject({
        method: 'POST',
        url: '/operator/updates/install-plan',
        headers: { 'x-runtime-token': 'private-test-token' },
        payload: { action: 'prepare' },
      });
      expect(reply.statusCode).toBe(409);
      expect(reply.json<{ message: string }>().message).toContain(
        'GitHub API 访问额度已耗尽（HTTP 403）',
      );
      expect(reply.json<{ message: string }>().message).toContain('请等待 GitHub API 额度恢复');
      expect(manager.status().failureDetails.at(-1)).toMatchObject({
        stage: 'install_plan',
        code: 'update_network_failed',
      });
      expect(manager.status().phase).toBe('error');
      await manager.check();
      expect(manager.status().phase).toBe('ready');
      source.latest.mockResolvedValueOnce(null);
      await expect(manager.prepare()).rejects.toMatchObject({
        message: 'update_recheck_required',
        cause: undefined,
      });
      expect(manager.status().failureDetails).toEqual([]);
      await manager.check();
      source.authenticate.mockRejectedValueOnce(
        new Error('unknown IO /home/private-user/private-path'),
      );
      const unknown = await app.inject({
        method: 'POST',
        url: '/operator/updates/install-plan',
        headers: { 'x-runtime-token': 'private-test-token' },
        payload: { action: 'prepare' },
      });
      expect(unknown.statusCode).toBe(409);
      expect(unknown.json<{ message: string }>().message).toContain('原因未知');
      expect(unknown.body).not.toContain('private-user');
    } finally {
      await app.close();
    }
  });

  it('reports tampered cached bytes through HTTP and clears that failure after a normal check', async () => {
    const { manager, root } = await setup();
    await manager.check();
    await manager.download();
    await finished(manager);
    expect(manager.status().phase).toBe('ready');
    const ready = JSON.parse(await readFile(join(root, 'updates/ready.json'), 'utf8')) as {
      directory: string;
    };
    const cached = join(root, 'updates', ready.directory, manifest.installer.name);
    // Keep the authenticated size: this must fail the digest check, not just a size check.
    await writeFile(cached, Buffer.alloc(bytes.length, 0));
    const app = buildApp({ updates: manager, productRuntime });
    try {
      const reply = await app.inject({
        method: 'POST',
        url: '/operator/updates/install-plan',
        headers: { 'x-runtime-token': 'private-test-token' },
        payload: { action: 'prepare' },
      });
      expect(reply.statusCode).toBe(409);
      expect(reply.json<{ message: string }>().message).toContain('下载内容与已认证清单不一致。');
      expect(reply.body).not.toContain('原因未知');
      expect(manager.status().phase).toBe('available');
      expect(manager.status().failureDetails.at(-1)).toMatchObject({
        stage: 'install_plan',
        code: 'update_download_corrupt',
      });
      await expect(readFile(cached)).rejects.toMatchObject({ code: 'ENOENT' });
      await manager.check();
      expect(manager.status()).toMatchObject({
        phase: 'available',
        error: null,
        failureDetails: [],
      });
      await manager.download();
      await finished(manager);
      const plan = await manager.prepare();
      expect(plan.installerSha256).toBe(manifest.installer.sha256);
      expect(await readFile(plan.installer)).toEqual(bytes);
      expect(manager.status()).toMatchObject({
        phase: 'installing',
        error: null,
        failureDetails: [],
      });
      manager.release();
    } finally {
      await app.close();
    }
  });

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
    expect(
      updateFailure('check', new Error('unknown original cause'), 'one').nextStep,
    ).not.toContain('网络恢复');
    expect(
      updateFailure('download_cleanup', new Error('update_cleanup_failed'), 'one').nextStep,
    ).toContain('进程占用');
    expect(updateFailure('settings_load', new SyntaxError('invalid JSON'), 'one')).toMatchObject({
      code: 'update_settings_invalid',
      summary: '更新记录无法读取或保存。',
    });
  });

  it('retains corrupt local records and their original diagnostic causes with local recovery guidance', async () => {
    const log =
      vi.fn<(stage: string, code: string, version?: string, diagnostic?: unknown) => void>();
    const { manager, root } = await setup({ log });
    const settings = '{ "automatic": false, "password": "secret-local-value", "lastAttempt": }';
    const result = '{ "status": "recovery-required", "version": }';
    await writeFile(join(root, 'updates/settings.json'), settings);
    await writeFile(join(root, 'updates/result.json'), result);
    await manager.load();
    expect(await readFile(join(root, 'updates/settings.json'), 'utf8')).toBe(settings);
    expect(await readFile(join(root, 'updates/result.json'), 'utf8')).toBe(result);
    await expect(manager.check()).rejects.toThrow('update_settings_invalid');
    for (const stage of ['settings_load', 'result_load']) {
      const failure = manager.status().failureDetails.find((value) => value.stage === stage)!;
      expect(failure.nextStep).toContain('不要删除记录');
      expect(failure.nextStep).not.toContain('网络');
      const entry = log.mock.calls.find(([value]) => value === stage)!;
      expect(entry[3]).toMatchObject({ error: { name: 'SyntaxError' } });
    }
    expect(JSON.stringify(log.mock.calls)).not.toContain('secret-local-value');
  });

  it('keeps a corrupt installation result visible across successful checks and downloads', async () => {
    const { manager, root } = await setup({ settingsAutomatic: true });
    const result = '{ "status": "recovery-required", "version": }';
    await writeFile(join(root, 'updates/result.json'), result);
    await manager.load();
    expect(manager.status().error).toBeNull();
    const failure = manager.status().failureDetails.find((value) => value.stage === 'result_load');
    expect(failure?.nextStep).toContain('不要删除记录');
    await manager.check();
    expect(manager.status().phase).toBe('available');
    expect(manager.status().failureDetails).toContainEqual(failure);
    await manager.download();
    await finished(manager);
    expect(manager.status().phase).toBe('ready');
    expect(manager.status().failureDetails).toContainEqual(failure);
    expect(await readFile(join(root, 'updates/result.json'), 'utf8')).toBe(result);
  });

  it('serializes overlapping preference saves and continues after an earlier failure', async () => {
    const { manager, root } = await setup({ settingsAutomatic: true });
    let rejectFirst!: (error: Error) => void;
    const firstSave = new Promise<void>((_, reject) => {
      rejectFirst = reject;
    });
    // Control only persistence completion; the manager owns mutation ordering.
    const persistence = manager as unknown as { saveConfig: () => Promise<void> };
    const realSave = persistence.saveConfig.bind(manager);
    const save = vi
      .spyOn(persistence, 'saveConfig')
      .mockImplementationOnce(() => firstSave)
      .mockImplementation(realSave);
    const first = manager.setAutomatic(false);
    const firstRejected = expect(first).rejects.toThrow('controlled disk failure');
    const second = manager.setAutomatic(false);
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(manager.status().automatic).toBe(false);
    expect(
      (
        JSON.parse(await readFile(join(root, 'updates/settings.json'), 'utf8')) as {
          automatic: boolean;
        }
      ).automatic,
    ).toBe(true);
    rejectFirst(new Error('controlled disk failure'));
    await firstRejected;
    await second;
    expect(save).toHaveBeenCalledTimes(2);
    expect(manager.status().automatic).toBe(false);
    expect(
      (
        JSON.parse(await readFile(join(root, 'updates/settings.json'), 'utf8')) as {
          automatic: boolean;
        }
      ).automatic,
    ).toBe(false);
  });

  it('preserves a settings write failure cause and the existing settings', async () => {
    const { manager, root } = await setup({ settingsAutomatic: true });
    const settings = await readFile(join(root, 'updates/settings.json'), 'utf8');
    await mkdir(join(root, 'updates/settings.tmp'));
    const error = await manager.setAutomatic(false).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(Error);
    const failure = error as Error & { cause: NodeJS.ErrnoException };
    expect(failure.message).toBe('update_settings_invalid');
    expect(failure.cause.code).toBeTypeOf('string');
    expect(await readFile(join(root, 'updates/settings.json'), 'utf8')).toBe(settings);
    expect(manager.status().automatic).toBe(true);
    expect(updateFailure('operator_action', error, 'one').nextStep).toContain('读写权限');
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
      if (scenario !== 'outside-updates') {
        const failure = manager
          .status()
          .failureDetails.find((value) => value.stage === 'result_identity_load');
        expect(failure?.nextStep).toContain('不要删除记录');
        await manager.check();
        expect(manager.status().failureDetails).toContainEqual(failure);
        expect(manager.status().lastResult).toBe('restored');
      }
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
  it('reports an expired total download deadline rather than an operator cancellation', async () => {
    const deadline = new AbortController();
    let started = false;
    const log =
      vi.fn<(stage: string, code: string, version?: string, diagnostic?: unknown) => void>();
    const { manager, root } = await setup({
      log,
      fetcher: (input, options) => {
        if (fetchUrl(input).includes('box.nju.edu.cn'))
          return Promise.resolve(new Response(null, { status: 503 }));
        return Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                started = true;
                controller.enqueue(bytes.subarray(0, 3));
                options?.signal?.addEventListener(
                  'abort',
                  () => controller.error(options.signal!.reason),
                  { once: true },
                );
              },
            }),
          ),
        );
      },
    });
    await manager.check();
    const nativeTimeout = AbortSignal.timeout.bind(AbortSignal);
    const timeout = vi
      .spyOn(AbortSignal, 'timeout')
      .mockImplementation((milliseconds) =>
        milliseconds === 15 * 60_000 ? deadline.signal : nativeTimeout(milliseconds),
      );
    try {
      await manager.download();
      await vi.waitFor(() => expect(started).toBe(true));
      deadline.abort(new DOMException('Total download deadline expired', 'TimeoutError'));
      await finished(manager);
      expect(manager.status()).toMatchObject({ phase: 'error', error: 'update_download_timeout' });
      expect(manager.status().failureDetails).toContainEqual(
        expect.objectContaining({
          code: 'update_download_timeout',
          summary: '安装包下载超时，未完成下载。',
        }),
      );
      const event = log.mock.calls.find(
        ([stage, code]) => stage === 'download' && code === 'update_download_timeout',
      );
      expect(event?.slice(0, 3)).toEqual(['download', 'update_download_timeout', '1.1.0']);
      expect(event?.[3]).toMatchObject({ error: { cause: { name: 'TimeoutError' } } });
      expect(
        (await readdir(join(root, 'updates'))).filter((p) => p.startsWith('download-')),
      ).toEqual([]);
      await expect(manager.prepare()).rejects.toThrow('update_unavailable');
    } finally {
      timeout.mockRestore();
    }
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
    expect(manager.notification('1.1.0')).toBeNull();
    await manager.setAutomatic(true);
    expect(manager.notification('wrong-version')).toBeNull();
    expect(manager.notification('1.1.0')).toEqual({ version: '1.1.0', notes: manifest.notes });
    expect(manager.notification('1.1.0')).toEqual({ version: '1.1.0', notes: manifest.notes });
    expect(manager.status().notificationPending).toBe(true);
    expect(manager.dismissNotification('wrong-version')).toBe(false);
    expect(manager.dismissNotification('1.1.0')).toBe(true);
    await manager.check();
    expect(manager.notification('1.1.0')).toBeNull();
    manager.desktopStartup('one');
    expect(manager.notification('1.1.0')).toBeNull();
    manager.desktopStartup('two');
    await manager.check();
    expect(manager.notification('1.1.0')).toEqual({ version: '1.1.0', notes: manifest.notes });
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
    expect(manager.notification('1.1.0')).toBeNull();
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
