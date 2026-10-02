import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { DebugEvidenceStore } from '../src/runtime/debug-state.js';
import { readSupportLogs, SUPPORT_LOG_READ_BYTES } from '../src/support/logs.js';
import { SUPPORT_BUNDLE_MAX_BYTES } from '../src/support/routes.js';

type SupportBundle = {
  manifest: Record<string, unknown>;
  logs: Awaited<ReturnType<typeof readSupportLogs>>;
  snapshot: { runtime: ReturnType<DebugEvidenceStore['getSupportSummary']> };
};

const gitSha = 'a'.repeat(40);
const artifactSha256 = 'b'.repeat(64);
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function directory() {
  const dir = await mkdtemp(join(tmpdir(), 'mizar-support-'));
  dirs.push(dir);
  return dir;
}
const request = {
  method: 'POST' as const,
  url: '/debug/support-bundle',
  headers: { origin: 'http://127.0.0.1:3000' },
  payload: {},
};

describe('support export', () => {
  it('joins actual startup log formats while retaining failure evidence and excluding arbitrary text', async () => {
    const dir = await directory();
    const secrets = [
      'private-hostname',
      'C:\\Users\\Private\\secret.txt',
      '/home/private/token',
      'https://private.example/?token=secret#personal',
      'rh_mizar_secretcredential',
      '76561198012345678',
      'private-nickname',
    ];
    const poison = secrets.join(' ');
    const identity = {
      startupSessionId: 'failed-session',
      gitSha,
      artifactSha256,
      appVersion: '0.1.0',
    };
    const desktop =
      JSON.stringify({
        ...identity,
        time: '2026-10-01T10:00:00.000Z',
        stage: 'webview2_preflight',
        result: 'failure',
        error: `${poison} (os error 2)`,
        hostname: secrets[0],
      }) + '\n';
    await writeFile(join(dir, 'desktop.ndjson.1'), desktop);
    await writeFile(
      join(dir, 'desktop.ndjson'),
      JSON.stringify({
        ...identity,
        startupSessionId: 'new-session',
        stage: 'main_window',
        result: 'success',
      }) + '\n',
    );
    await writeFile(
      join(dir, 'supervisor.ndjson'),
      JSON.stringify({
        ...identity,
        timestamp: '2026-10-01T10:00:00.001Z',
        stage: 'companion_exit',
        code: 1,
        signal: poison,
      }) + '\n',
    );
    await writeFile(
      join(dir, 'companion.log'),
      [
        JSON.stringify({ startupSessionId: 'failed-session', stage: 'companion_output_start' }),
        JSON.stringify({
          level: 50,
          time: Date.parse('2026-10-01T10:00:00Z'),
          hostname: secrets[0],
          msg: poison,
          req: { url: secrets[3] },
          res: { statusCode: 500 },
          err: { stack: poison },
          unknown: secrets,
        }),
      ].join('\n'),
    );
    await writeFile(join(dir, 'companion.stderr.log'), poison);
    await writeFile(join(dir, 'runtime.json'), poison);
    const evidence = new DebugEvidenceStore();
    evidence.recordAcceptedRaw({
      sequence: 1,
      receivedAt: new Date().toISOString(),
      receivedMonotonicMs: 1,
      payload: { auth: { token: poison }, allplayers: { [secrets[5]!]: { name: poison } } },
    });
    evidence.recordRuntimeDiagnostic(poison);
    evidence.recordGsiDiagnostics({
      entries: [{ code: 'INVALID_FIELD', severity: 'warning', path: poison, rawValue: poison }],
      suppressedCount: 3,
    });
    const app = buildApp({
      supportLogsDirectory: dir,
      debugEvidenceStore: evidence,
      gsiToken: poison,
      productRuntime: {
        gitSha,
        artifactSha256,
        instanceId: poison,
        controlToken: poison,
        stop() {},
      },
    });
    try {
      const response = await app.inject(request);
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.headers['content-disposition']).toContain('mizar-support-');
      for (const secret of [
        ...secrets,
        'failed-session',
        'new-session',
        'allplayers',
        'rawValue',
        'controlToken',
      ])
        expect(response.body).not.toContain(secret);
      const bundle = response.json<SupportBundle>();
      expect(bundle.manifest).toMatchObject({ gitSha, artifactSha256 });
      const failed = bundle.logs.find((log: { name: string }) => log.name === 'desktop.ndjson.1')
        ?.events[0];
      expect(failed).toMatchObject({
        stage: 'webview2_preflight',
        result: 'failure',
        osErrorCode: 2,
        appVersion: '0.1.0',
        hasLocalError: true,
      });
      expect(
        bundle.logs.find((log: { name: string }) => log.name === 'supervisor.ndjson')?.events[0],
      ).toMatchObject({ session: failed?.session, exitCode: 1 });
      expect(
        bundle.logs.find((log: { name: string }) => log.name === 'companion.log')?.events[1],
      ).toMatchObject({ session: failed?.session, level: 50, httpStatus: 500 });
      expect(bundle.snapshot.runtime.gsiDiagnostics).toMatchObject({
        suppressedCount: 3,
        recent: [{ code: 'INVALID_FIELD', severity: 'warning' }],
      });
      expect(bundle.logs).toHaveLength(16);
      expect(await readFile(join(dir, 'desktop.ndjson.1'), 'utf8')).toBe(desktop);
      const second = (await app.inject(request)).json<SupportBundle>();
      expect(
        second.logs.find((log: { name: string }) => log.name === 'desktop.ndjson.1')?.events[0]
          ?.session,
      ).not.toBe(failed?.session);
    } finally {
      await app.close();
    }
  });

  it('caps large rotated logs and produces a usable export instead of persistent oversize failures', async () => {
    const dir = await directory();
    const line =
      JSON.stringify({
        startupSessionId: 'x'.repeat(96),
        timestamp: '2026-10-01T10:00:00.000Z',
        stage: 'supervisor_error',
        result: 'failure',
        gitSha,
        artifactSha256,
        appVersion: '9999.9999.9999',
        code: 2147483647,
        error: `${'x'.repeat(800)} (os error 999999)`,
      }) + '\n';
    for (const name of [
      'desktop.ndjson',
      'supervisor.ndjson',
      'companion.log',
      'companion.stderr.log',
    ])
      for (const suffix of ['', '.1', '.2', '.3'])
        await writeFile(join(dir, name + suffix), line.repeat(300));
    const app = buildApp({ supportLogsDirectory: dir });
    try {
      const response = await app.inject(request);
      expect(response.statusCode).toBe(200);
      expect(Buffer.byteLength(response.body)).toBeLessThanOrEqual(SUPPORT_BUNDLE_MAX_BYTES);
      for (const log of response.json<SupportBundle>().logs) {
        expect(log.readBytes).toBeLessThanOrEqual(SUPPORT_LOG_READ_BYTES + 4096);
        expect(log.truncated).toBe(true);
        expect(log.events.length).toBeGreaterThan(0);
        expect(log.events.length).toBeLessThanOrEqual(32);
        expect(log.events.at(-1)?.result).toBe('failure');
      }
    } finally {
      await app.close();
    }
  });

  it('keeps a long escaped Desktop failure among later healthy records', async () => {
    const dir = await directory();
    const failure = JSON.stringify({
      startupSessionId: 's',
      stage: 'main_window',
      result: 'failure',
      error: '\\'.repeat(8192),
    });
    const healthy = JSON.stringify({
      startupSessionId: 's',
      stage: 'main_page_load',
      result: 'success',
    });
    await writeFile(
      join(dir, 'desktop.ndjson'),
      [failure, ...Array<string>(40).fill(healthy)].join('\n'),
    );
    const logs = await readSupportLogs(dir);
    expect(logs[0]?.events).toHaveLength(32);
    expect(logs[0]?.events[0]).toMatchObject({
      stage: 'main_window',
      result: 'failure',
      hasLocalError: true,
    });
    expect(logs[0]?.truncated).toBe(true);
  });

  it.skipIf(process.platform === 'win32')('rejects symlink log targets', async () => {
    const dir = await directory();
    await writeFile(
      join(dir, 'secret'),
      JSON.stringify({ stage: 'main_window', result: 'success' }),
    );
    await symlink(join(dir, 'secret'), join(dir, 'desktop.ndjson'));
    expect((await readSupportLogs(dir))[0]).toMatchObject({
      status: 'not_regular_file',
      events: [],
    });
  });

  it('requires a local Origin and denies LAN export without revealing local data', async () => {
    for (const origin of [undefined, 'https://evil.example', 'null']) {
      const app = buildApp();
      try {
        expect(
          (await app.inject({ ...request, headers: origin === undefined ? {} : { origin } }))
            .statusCode,
        ).toBe(403);
      } finally {
        await app.close();
      }
    }
    const app = buildApp({
      host: '0.0.0.0',
      localWebLanMode: true,
      localWebAllowedOrigins: ['http://127.0.0.1:3000'],
    });
    try {
      expect((await app.inject(request)).statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });
});
