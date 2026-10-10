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
  it('exports native Demo stages and correlated Companion exceptions through the user bundle', async () => {
    const dir = await directory();
    const operationId = '12345678-abcd-1234-abcd-123456789012';
    const requestId = '87654321-abcd-1234-abcd-123456789012';
    await writeFile(
      join(dir, 'desktop.ndjson'),
      [
        { phase: 'file_canonicalize', errorKind: 'NotFound', osCode: 2, cause: 'file not found' },
        { phase: 'runtime_json', category: 'Eof', line: 1, column: 42 },
        {
          phase: 'response_http',
          status: 409,
          code: 'demo_test_future_failure',
          stage: 'future_restore_stage',
          operationId,
          requestId,
          occurrences: 16,
        },
      ]
        .map((error) =>
          JSON.stringify({ stage: 'demo_test', result: 'failure', error: JSON.stringify(error) }),
        )
        .join('\n'),
    );
    await writeFile(
      join(dir, 'companion.log'),
      JSON.stringify({
        event: 'demo-test',
        stage: 'formal_restore',
        result: 'failure',
        diagnostic: {
          operationId,
          requestId,
          error: {
            name: 'Error',
            message: 'restore failed',
            cause: { code: 'EACCES', message: 'permission denied', password: 'do-not-export' },
          },
        },
      }),
    );
    const app = buildApp({ supportLogsDirectory: dir });
    try {
      const response = await app.inject(request);
      expect(response.statusCode).toBe(200);
      expect(response.body).not.toContain('do-not-export');
      const logs = response.json<SupportBundle>().logs;
      const native = logs.find((log) => log.name === 'desktop.ndjson')!.events;
      expect(native[0]).toMatchObject({
        stage: 'demo_test',
        demoPhase: 'file_canonicalize',
        osErrorCode: 2,
        localDiagnostic: { errorKind: 'NotFound', cause: 'file not found' },
      });
      expect(native[1]).toMatchObject({
        demoPhase: 'runtime_json',
        localDiagnostic: { category: 'Eof', line: 1, column: 42 },
      });
      expect(native[2]).toMatchObject({
        demoCode: 'demo_test_future_failure',
        operationId,
        requestId,
        occurrences: 16,
        localDiagnostic: { status: 409, stage: 'future_restore_stage' },
      });
      expect(logs.find((log) => log.name === 'companion.log')!.events[0]).toMatchObject({
        stage: 'formal_restore',
        operationId,
        requestId,
        localDiagnostic: { cause: { code: 'EACCES', message: 'permission denied' } },
      });
    } finally {
      await app.close();
    }
  });

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
        stage: 'powershell',
        result: 'failure',
        error: poison,
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
        JSON.stringify({
          event: 'update',
          stage: 'github_download',
          code: 'update_network_failed',
          diagnostic: {
            operationId: '12345678-abcd-1234-abcd-123456789012',
            error: {
              status: 503,
              source: 'github.com',
              message: poison,
              cause: { code: 'ECONNRESET', stack: poison },
            },
          },
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
      expect(bundle.logs.find((log) => log.name === 'companion.log')?.events[2]).toMatchObject({
        stage: 'github_download',
        updateCode: 'update_network_failed',
        operationId: '12345678-abcd-1234-abcd-123456789012',
        hasLocalError: true,
        causes: [{ httpStatus: 503, source: 'github.com' }, { code: 'ECONNRESET' }],
      });
      expect(bundle.snapshot.runtime.gsiDiagnostics).toMatchObject({
        suppressedCount: 3,
        recent: [{ code: 'INVALID_FIELD', severity: 'warning' }],
      });
      expect(bundle.logs.find((log) => log.name === 'desktop.ndjson')?.events[0]).toMatchObject({
        stage: 'powershell',
        result: 'failure',
        hasLocalError: true,
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

  it('exports classified GSI failures and counts while rejecting local paths and arbitrary error text', async () => {
    const app = buildApp();
    const gsi = {
      collectionStatus: 'available',
      readFailed: true,
      candidateCount: 2,
      conflictCount: 1,
      issueCodes: ['multiple-installations', 'endpoint-conflict'],
      lastOperation: { code: 'restore-before-selection', stage: 'selection' },
    };
    try {
      const response = await app.inject({ ...request, payload: { desktop: { gsi } } });
      expect(response.statusCode).toBe(200);
      expect(response.json<{ snapshot: { gsi: unknown } }>().snapshot.gsi).toMatchObject(gsi);
      for (const collectionStatus of ['failed', 'timeout']) {
        const unavailable = await app.inject({
          ...request,
          payload: { desktop: { gsi: { collectionStatus } } },
        });
        expect(unavailable.json<{ snapshot: { gsi: unknown } }>().snapshot.gsi).toMatchObject({
          collectionStatus,
          installed: null,
          conflict: null,
          candidateCount: null,
        });
      }
      for (const extra of [
        { cfgPath: 'C:\\Users\\private\\cfg' },
        { conflictFiles: ['gamestate_integration_secret-token.cfg'] },
      ]) {
        const sanitized = await app.inject({
          ...request,
          payload: { desktop: { gsi: { ...gsi, ...extra } } },
        });
        expect(sanitized.statusCode).toBe(200);
        expect(sanitized.body).not.toContain('private');
        expect(sanitized.body).not.toContain('secret-token');
        expect(sanitized.json<{ snapshot: { gsi: unknown } }>().snapshot.gsi).toMatchObject(gsi);
      }
      for (const extra of [
        { issueCodes: ['private-token'] },
        { lastOperation: { code: 'operation-failed', stage: 'private-text' } },
      ]) {
        const invalid = await app.inject({
          ...request,
          payload: { desktop: { gsi: { ...gsi, ...extra } } },
        });
        expect(invalid.statusCode).toBe(400);
      }
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

  it('bounds large cause chains per event while retaining the latest failure in every file', async () => {
    const dir = await directory();
    const leaf = {
      name: 'Error',
      message: 'latest original cause ' + '故障'.repeat(700),
      stack: 'at C:\\Users\\private-user\\Mizar\\network.js:12:1 ' + 'x'.repeat(700),
    };
    const line =
      JSON.stringify({
        event: 'update',
        stage: 'download',
        result: 'failure',
        code: 'update_operation_failed',
        time: Date.now(),
        diagnostic: {
          error: {
            name: 'AggregateError',
            message: 'latest transfer failed',
            errors: Array.from({ length: 4 }, () => ({ ...leaf, cause: leaf })),
          },
        },
      }) + '\n';
    for (const name of [
      'desktop.ndjson',
      'supervisor.ndjson',
      'companion.log',
      'companion.stderr.log',
    ])
      for (const suffix of ['', '.1', '.2', '.3'])
        await writeFile(join(dir, name + suffix), line.repeat(5));
    const app = buildApp({ supportLogsDirectory: dir });
    try {
      const response = await app.inject(request);
      expect(response.statusCode).toBe(200);
      expect(Buffer.byteLength(response.body)).toBeLessThanOrEqual(SUPPORT_BUNDLE_MAX_BYTES);
      expect(response.body).not.toContain('private-user');
      for (const log of response.json<SupportBundle>().logs) {
        const diagnostic = JSON.stringify(log.events.at(-1));
        expect(diagnostic).toContain('latest transfer failed');
        expect(diagnostic).toContain('latest original cause');
        expect(diagnostic).toContain('truncated');
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
    expect(logs[0]?.events).toHaveLength(2);
    expect(logs[0]?.events[1]).toMatchObject({ stage: 'main_page_load', occurrences: 40 });
    expect(logs[0]?.events[0]).toMatchObject({
      stage: 'main_window',
      result: 'failure',
      hasLocalError: true,
    });
    expect(logs[0]?.truncated).toBe(true);
  });

  it('reads native rotated logs and preserves multiple failure chains ahead of ordinary events', async () => {
    const dir = await directory();
    const failures = ['steam_launch', 'main_window', 'runtime_spawn'].map((stage) => ({
      startupSessionId: 'session',
      stage,
      result: 'failure',
      error: 'outer failure: OS access denied (os error 5)',
    }));
    // steam_launch is not a known export stage; the two known boundaries retain evidence.
    await writeFile(
      join(dir, 'desktop.1.ndjson'),
      [
        ...failures,
        {
          stage: 'cs2_launch',
          result: 'success',
          detail: 'stage=observe; stderr=window not ready\npassword=private-secret',
        },
        {
          stage: 'workspace_group_restore',
          result: 'failure',
          detail: JSON.stringify({
            stage: 'restore',
            api: 'ShowWindowAsync',
            lastError: 5,
            gamePid: 1234,
            created: 'private-process-identity',
            path: 'C:\\Users\\private-user\\private-installation\\cs2.exe',
            password: 'private-window-secret',
          }),
        },
        ...Array.from({ length: 80 }, () => ({ stage: 'main_page_load', result: 'success' })),
      ]
        .map((event) => JSON.stringify(event))
        .join('\n'),
    );
    const history = (await readSupportLogs(dir)).find((file) => file.name === 'desktop.1.ndjson')!;
    expect(history.events.filter((event) => event.hasLocalError)).toHaveLength(2);
    expect(JSON.stringify(history.events)).toContain('OS access denied');
    expect(JSON.stringify(history.events)).toContain('window not ready');
    expect(JSON.stringify(history.events)).not.toContain('private-secret');
    expect(history.events.find((event) => event.stage === 'workspace_group_restore')).toMatchObject(
      {
        result: 'failure',
        localDiagnostic: { stage: 'restore', api: 'ShowWindowAsync', lastError: 5 },
      },
    );
    expect(JSON.stringify(history.events)).not.toMatch(
      /private-(?:process|user|installation|window)/,
    );
    expect(history.events.find((event) => event.stage === 'cs2_launch')).toHaveProperty(
      'localDiagnostic',
    );
    expect(history.events.at(-1)).toMatchObject({ stage: 'main_page_load', occurrences: 80 });
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
