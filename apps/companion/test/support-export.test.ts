import * as nativeObs from '../src/obs/native-evidence.js';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { outboxLocalError } from '../src/output/reliable-outbox.js';
import {
  RivalHubConnection,
  OFFICIAL_RIVALHUB_URL,
} from '../src/match-context/rivalhub-connection.js';
import { registerRivalHubConnectionRoutes } from '../src/match-context/rivalhub-routes.js';
import type { LiveSnapshotV1, ReliableEventV1 } from '@mizar/protocol/output';
import { buildApp } from '../src/app.js';
import { DebugEvidenceStore } from '../src/runtime/debug-state.js';
import { readSupportLogs, SUPPORT_LOG_READ_BYTES } from '../src/support/logs.js';
import { SUPPORT_BUNDLE_MAX_BYTES } from '../src/support/routes.js';
import { ObsAdapter, obsErrorEvidence } from '../src/obs/adapter.js';
import { ObsOutputError } from '../src/obs/outputs.js';

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
  it('retains the ordinary bundle when optional native evidence fails', async () => {
    const collector = vi
      .spyOn(nativeObs, 'collectObsNativeEvidence')
      .mockRejectedValue(
        Object.assign(new Error('access denied C:\\Users\\Alice\\private'), { code: 'EACCES' }),
      );
    const app = buildApp();
    try {
      const response = await app.inject(request);
      expect(response.statusCode).toBe(200);
      expect(
        response.json<{ snapshot: { nativeObs: unknown } }>().snapshot.nativeObs,
      ).toMatchObject({
        collectionStatus: 'failed',
        errors: [{ code: 'EACCES' }],
      });
      expect(
        response.json<{ snapshot: { program: { active: string } } }>().snapshot.program.active,
      ).toBe('waiting');
      expect(response.body).not.toMatch(/Alice|private/);
    } finally {
      await app.close();
      collector.mockRestore();
    }
  });

  it('exports Program alignment and safe source evidence without arbitrary scene names or credentials', async () => {
    const dir = await directory();
    const status = vi.spyOn(ObsAdapter.prototype, 'status').mockResolvedValue({
      connection: 'connected',
      currentScene: 'private-user-scene',
      port: 4455,
      streaming: false,
      recording: false,
      passwordConfigured: true,
      video: null,
      findings: [],
      programEvidence: {
        state: 'measured',
        collection: 'other',
        sceneId: null,
        composition: null,
        studio: { enabled: true, previewSceneId: 'gameplay', previewMatchesProgram: false },
        layers: [],
        layersTruncated: false,
        sources: [],
        capture: null,
      },
    });
    await writeFile(
      join(dir, 'companion.log'),
      JSON.stringify({
        event: 'obs',
        stage: 'obs_program_check',
        result: 'failure',
        diagnostic: {
          error: obsErrorEvidence(
            Object.assign(new Error('source query failed private-password'), { code: 600 }),
            'private-password',
          ),
        },
      }),
    );
    const app = buildApp({ supportLogsDirectory: dir, obsConfigPath: join(dir, 'obs.json') });
    try {
      const response = await app.inject(request);
      expect(response.statusCode).toBe(200);
      const bundle = response.json<{
        snapshot: Record<string, unknown>;
        logs: SupportBundle['logs'];
      }>();
      expect(bundle.snapshot).toMatchObject({
        program: {
          active: 'waiting',
          preparing: null,
          mode: 'preparation',
          gameplayAvailable: false,
        },
        obs: {
          currentScene: null,
          sceneAligned: false,
          programEvidence: {
            collection: 'other',
            studio: { enabled: true, previewSceneId: 'gameplay', previewMatchesProgram: false },
            layers: [],
            layersTruncated: false,
          },
        },
      });
      expect(bundle.logs.find((log) => log.name === 'companion.log')!.events[0]).toMatchObject({
        stage: 'obs_program_check',
        localDiagnostic: { code: 600, message: 'source query failed [redacted]' },
      });
      expect(response.body).not.toContain('private-user-scene');
      expect(response.body).not.toContain('private-password');
    } finally {
      await app.close();
      status.mockRestore();
    }
  });
  it.each([
    { rpcCode: 702, code: 'obs_output_failed' as const, reason: 'encoder initialization failed' },
    { rpcCode: 504, code: 'obs_output_disabled' as const, reason: 'output is disabled' },
    { rpcCode: null, code: 'obs_output_unconfirmed' as const, reason: 'OBS output timeout' },
  ])(
    'exports OBS output $rpcCode failures and their safe cause through the user bundle',
    async ({ rpcCode, code, reason }) => {
      const dir = await directory();
      const original = Object.assign(
        new Error(
          `${reason}\nrtmps://private-output.example/live/private-stream-key\nhttps://private-control.example/?key=private-query\nws://private-websocket.example/secret\nstreamKey=private-key-field\npassword=private-obs-password`,
          { cause: Object.assign(new Error('transport permission denied'), { code: 'EACCES' }) },
        ),
        rpcCode === null ? {} : { code: rpcCode },
      );
      const entries = [
        { stage: 'obs_output', error: original },
        {
          stage: 'obs_output_command',
          error: new ObsOutputError(code, 'OBS output command rejected', { cause: original }),
        },
      ].map(({ stage, error }) => ({
        event: 'obs',
        stage,
        result: 'failure',
        level: 40,
        diagnostic: { error: obsErrorEvidence(error, 'private-obs-password') },
      }));
      const path = join(dir, 'companion.log');
      const localLog = entries.map((entry) => JSON.stringify(entry)).join('\n');
      await writeFile(path, localLog);
      const app = buildApp({ supportLogsDirectory: dir });
      try {
        const response = await app.inject(request);
        expect(response.statusCode).toBe(200);
        const events = response
          .json<SupportBundle>()
          .logs.find((log) => log.name === 'companion.log')!.events;
        expect(events).toHaveLength(2);
        expect(events[0]).toMatchObject({
          stage: 'obs_output',
          result: 'failure',
          hasLocalError: true,
          localDiagnostic: { cause: { code: 'EACCES', message: 'transport permission denied' } },
        });
        expect(events[1]).toMatchObject({
          stage: 'obs_output_command',
          result: 'failure',
          hasLocalError: true,
          localDiagnostic: { code, cause: { cause: { code: 'EACCES' } } },
        });
        for (const event of events) expect(JSON.stringify(event.localDiagnostic)).toContain(reason);
        if (rpcCode !== null) {
          expect(events[0]!.localDiagnostic).toMatchObject({ code: rpcCode });
          expect(events[1]!.localDiagnostic).toMatchObject({ cause: { code: rpcCode } });
        }
        for (const secret of [
          'private-output',
          'private-stream-key',
          'private-control',
          'private-query',
          'private-websocket',
          'private-key-field',
          'private-obs-password',
        ])
          expect(response.body).not.toContain(secret);
        expect(await readFile(path, 'utf8')).toBe(localLog);
        expect(localLog).toContain('private-stream-key');
        expect(localLog).toContain('private-key-field');
      } finally {
        await app.close();
      }
    },
  );

  it('exports observer CFG and restore evidence through the user bundle without private configuration contents', async () => {
    const dir = await directory();
    const prepared = { stage: 'prepared', file: 'mizar_observer.cfg', runtime: 'unverified' };
    await writeFile(
      join(dir, 'desktop.ndjson'),
      [
        { stage: 'cs2_spectator_cfg', result: 'success', detail: JSON.stringify(prepared) },
        {
          stage: 'cs2_spectator_cfg',
          result: 'failure',
          error: JSON.stringify({
            ...prepared,
            reason: '观战 CFG 无法部署。 [ioKind=PermissionDenied; osCode=5]',
            original: 'private-convar-body',
            path: 'C:\\Users\\Private\\game.cfg',
            password: 'private-password',
          }),
        },
        {
          stage: 'cs2_spectator_restore',
          result: 'failure',
          error:
            '观战恢复记录损坏。 [jsonCategory=Eof; line=3; column=17]\npassword=private-secret',
        },
        {
          stage: 'cs2_spectator_restore',
          result: 'success',
          detail: 'stage=retry; originalField=restored',
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join('\n'),
    );
    const app = buildApp({ supportLogsDirectory: dir });
    try {
      const response = await app.inject(request);
      expect(response.statusCode).toBe(200);
      for (const secret of ['private-convar-body', 'Private', 'private-password', 'private-secret'])
        expect(response.body).not.toContain(secret);
      const events = response
        .json<SupportBundle>()
        .logs.find((log) => log.name === 'desktop.ndjson')!.events;
      expect(events).toHaveLength(4);
      expect(
        events.find((event) => event.stage === 'cs2_spectator_cfg' && event.result === 'success'),
      ).toMatchObject({
        localDiagnostic: { phase: 'prepared', runtime: 'unverified', file: 'mizar_observer.cfg' },
      });
      expect(
        events.find((event) => event.stage === 'cs2_spectator_cfg' && event.result === 'failure'),
      ).toMatchObject({
        osErrorCode: 5,
        localDiagnostic: { errorKind: 'PermissionDenied', osCode: 5 },
      });
      expect(
        events.find(
          (event) => event.stage === 'cs2_spectator_restore' && event.result === 'failure',
        ),
      ).toMatchObject({ localDiagnostic: { category: 'Eof', line: 3, column: 17 } });
      expect(
        events.find(
          (event) => event.stage === 'cs2_spectator_restore' && event.result === 'success',
        ),
      ).toMatchObject({ localDiagnostic: { phase: 'retry' } });
    } finally {
      await app.close();
    }
  });

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
        JSON.stringify({
          event: 'update',
          stage: 'install_plan',
          code: 'update_obs_process_probe_failed',
          result: 'failure',
          diagnostic: {
            error: {
              name: 'Error',
              message: 'OBS process probe timeout',
              code: 'ETIMEDOUT',
              cause: { message: poison },
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
      expect(bundle.logs.find((log) => log.name === 'companion.log')?.events[3]).toMatchObject({
        stage: 'install_plan',
        updateCode: 'update_obs_process_probe_failed',
        hasLocalError: true,
        localDiagnostic: { message: 'OBS process probe timeout', code: 'ETIMEDOUT' },
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
        {
          stage: 'cs2_startup_recovery',
          result: 'failure',
          detail:
            'restore failed: writeback mismatch; stderr=access denied at C:\\Users\\private-startup\\cfg\npassword=private-recovery-secret',
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
    const recovery = history.events.find((event) => event.stage === 'cs2_startup_recovery');
    expect(recovery).toMatchObject({ result: 'failure' });
    expect(JSON.stringify(recovery?.localDiagnostic)).toContain('writeback mismatch');
    expect(JSON.stringify(recovery?.localDiagnostic)).toContain('access denied');
    expect(JSON.stringify(recovery)).not.toMatch(/private-(?:startup|recovery)/);

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

it('exports actual LIVE diagnostic logs with stage and safe network causes through the existing support projection', async () => {
  const dir = await directory();
  const path = join(dir, 'connection.json');
  await writeFile(
    path,
    JSON.stringify({
      baseUrl: OFFICIAL_RIVALHUB_URL,
      credential: 'private-token',
      installationId: 'installation',
      competitionId: 'competition',
      displayName: 'Test',
    }),
  );
  let recovering = false;
  const connection = new RivalHubConnection(path, (url) => {
    const endpoint = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
    if (endpoint.endsWith('/claim'))
      return Promise.resolve(Response.json({ claimed: true, authorityRevision: 1 }));
    if (endpoint.endsWith('/reliable')) return Promise.resolve(new Response(null, { status: 204 }));
    return recovering
      ? Promise.resolve(Response.json({ accepted: true }))
      : Promise.reject(
          new TypeError('https://private.example/?token=private-token', {
            cause: Object.assign(new Error('Bearer private-token'), {
              name: 'FutureTransportError',
              code: 'NEW_NETWORK_CODE',
            }),
          }),
        );
  });
  await connection.load();
  const logs: string[] = [];
  const app = Fastify({
    logger: {
      stream: {
        write(text: string) {
          logs.push(text);
        },
      },
    },
  });
  registerRivalHubConnectionRoutes(app, {
    connection,
    controller: null,
    currentSnapshot: () => null,
    originPolicy: {
      mode: 'loopback',
      bindHost: '127.0.0.1',
      allowedOrigins: ['http://127.0.0.1:3000'],
    },
  });
  const snapshot = {
    matchId: 'match',
    competitionId: 'competition',
    players: [],
    cursor: {
      producerInstanceId: 'producer',
      liveSessionId: 'session',
      programSourceGeneration: 1,
      mapEpoch: 1,
    },
  } as unknown as LiveSnapshotV1;
  await connection.claim(snapshot, 'revision', false);
  await connection.sendReliable(
    { kind: 'map_started', matchId: 'match', cursor: snapshot.cursor } as ReliableEventV1,
    snapshot,
  );
  let now = 0;
  const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
  try {
    await connection.sendLive(snapshot);
    now = 10000;
    for (let index = 0; index < 3; index++) await connection.sendLive(snapshot);
    await expect(connection.sendLive(snapshot)).rejects.toThrow('rivalhub_live_unavailable');
    await connection.sendLive(snapshot);
    recovering = true;
    await connection.sendLive(snapshot);
    await writeFile(join(dir, 'companion.log'), logs.join(''));
    const exported = await readSupportLogs(dir);
    const events = exported.find((entry) => entry.name === 'companion.log')!.events;
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      stage: 'fetch',
      result: 'failure',
      localDiagnostic: {
        name: 'TypeError',
        cause: { name: 'FutureTransportError', code: 'NEW_NETWORK_CODE' },
      },
    });
    expect(events[1]).toMatchObject({ stage: 'accepted', result: 'success' });
    for (const text of [logs.join(''), JSON.stringify(exported)]) {
      expect(text).not.toContain('private-token');
      expect(text).not.toContain('private.example');
    }
  } finally {
    clock.mockRestore();
    await app.close();
  }
});

it('exports outbox recovery cause without JSON.parse fragments or private paths', async () => {
  const dir = await directory();
  const lines: string[] = [];
  const logger = Fastify({
    logger: {
      level: 'warn',
      stream: {
        write: (line: string) => {
          lines.push(line);
        },
      },
    },
  });
  const malformed = new SyntaxError('Unexpected token private-team-name secret-token');
  const invalidRecord = Object.assign(new Error('unrecognized key private-rejected-value'), {
    name: 'ZodError',
  });
  const io = Object.assign(new Error('Access denied C:\\Users\\private-user\\queue.json'), {
    code: 'EACCES',
  });
  const raw = new AggregateError([malformed, invalidRecord, io], 'queue recovery');
  try {
    logger.log.warn(
      {
        event: 'outbox',
        stage: 'outbox_load',
        recovery: { code: 'outbox_recovered', recoveredRecords: 2, secret: 'private-payload' },
        err: outboxLocalError(raw),
      },
      'queue recovery',
    );
    logger.log.warn(
      {
        event: 'outbox',
        stage: 'outbox_load',
        result: 'unconfirmed',
        recovery: { code: 'outbox_preserved_without_records', recoveredRecords: 0 },
        err: outboxLocalError(malformed),
      },
      'old events isolated',
    );
    // Also cover Pino standard AggregateError serialization, not a handwritten shape.
    logger.log.warn({ event: 'outbox', stage: 'outbox_load', err: raw }, 'queue recovery');
    logger.log.error(
      Object.assign(new Error('queue preservation failed', { cause: io }), {
        code: 'outbox_recovery_failed',
      }),
      'startup failed',
    );
    expect(lines.join('')).toContain('private-team-name');
    expect(lines.join('')).toContain('EACCES');
    await writeFile(join(dir, 'companion.log'), lines.join(''));
  } finally {
    await logger.close();
  }
  const result = await readSupportLogs(dir);
  const serialized = JSON.stringify(result);
  expect(serialized).toContain('outbox_recovered');
  expect(result.flatMap((log) => log.events)).toContainEqual(
    expect.objectContaining({
      stage: 'outbox_load',
      result: 'unconfirmed',
      recoveryCode: 'outbox_preserved_without_records',
      recoveredRecords: 0,
    }),
  );
  expect(serialized).toContain('recoveredRecords');
  expect(serialized).toContain('SyntaxError');
  expect(serialized).toContain('EACCES');
  expect(serialized).toContain('Access denied');
  expect(serialized).not.toContain('private-team-name');
  expect(serialized).not.toContain('secret-token');
  expect(serialized).not.toContain('private-user');
  expect(serialized).not.toContain('private-payload');
  expect(serialized).not.toContain('private-rejected-value');
});

it('exports the OBS exit probe failure with bounded redacted causes for the exact event', async () => {
  const dir = await directory();
  const lines: string[] = [];
  const logger = Fastify({
    logger: {
      level: 'warn',
      stream: {
        write: (line: string) => {
          lines.push(line);
        },
      },
    },
  });
  const cause = Object.assign(new Error('process query timed out'), { code: 'ETIMEDOUT' });
  const error = new Error('OBS query failed C:\\Users\\private-user\\obs.exe', { cause });
  try {
    const entry = {
      event: 'obs',
      stage: 'obs_exit_process_probe',
      result: 'failure',
      diagnostic: { error: obsErrorEvidence(error), unknown: 'private-extra' },
      unknown: 'private-extra',
    };
    logger.log.warn(entry, 'private log message');
    logger.log.warn(
      { ...entry, event: 'unknown', diagnostic: { error: { code: 'private-code' } } },
      'unknown event',
    );
    logger.log.warn(
      { event: 'obs', stage: 'unknown_probe', result: 'unconfirmed' },
      'unknown probe',
    );
    await writeFile(join(dir, 'companion.log'), lines.join(''));
  } finally {
    await logger.close();
  }
  const logs = await readSupportLogs(dir);
  const events = logs.flatMap((log) => log.events);
  expect(events[0]).toMatchObject({
    stage: 'obs_exit_process_probe',
    result: 'failure',
    hasLocalError: true,
    causes: [{ code: null }, { code: 'ETIMEDOUT' }],
    localDiagnostic: {
      message: 'OBS query failed C:\\Users\\[user]\\obs.exe',
      cause: { message: 'process query timed out', code: 'ETIMEDOUT' },
    },
  });
  expect(events[1]).toMatchObject({ stage: 'companion_structured_log' });
  expect(events[1]).not.toHaveProperty('causes');
  expect(events[2]).toMatchObject({ result: null });
  const serialized = JSON.stringify(logs);
  for (const secret of ['private-user', 'private-extra', 'private log message', 'private-code'])
    expect(serialized).not.toContain(secret);
  expect(Buffer.byteLength(serialized)).toBeLessThan(8192);
});
