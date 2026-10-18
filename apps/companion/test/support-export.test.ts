import { DiagnosticDelivery } from '../src/support/delivery.js';
import { fullLogArchive } from '../src/support/archive.js';
import { execFileSync } from 'node:child_process';
import type { MusicConfig, MusicTrack } from '@mizar/protocol/music';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { SessionJournal, SESSION_LIMITS } from '../src/support/session-journal.js';
import * as filesystem from 'node:fs/promises';
import Fastify from 'fastify';
import { createWriteStream } from 'node:fs';
import { registerRivalHubConnectionRoutes } from '../src/match-context/rivalhub-routes.js';
import type { MatchContextController } from '../src/match-context/controller.js';
import { mkdtemp, rm, symlink, writeFile, readFile, stat, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RivalHubConnection,
  OFFICIAL_RIVALHUB_URL,
} from '../src/match-context/rivalhub-connection.js';
import type { LiveSnapshotV1, ReliableEventV1 } from '@mizar/protocol/output';
import { buildApp } from '../src/app.js';
import * as nativeProcesses from '../src/obs/native-process.js';
import { readSupportLogs } from '../src/support/logs.js';
import { BusinessJournal } from '../src/support/business-journal.js';
import {
  readBusinessHistory,
  BUSINESS_HISTORY_FILE,
  BUSINESS_HISTORY_LIMITS,
} from '../src/support/business-history.js';
vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof import('node:fs/promises')>()),
}));
const dirs: string[] = [];
// Native OBS discovery has its own OS consumer; these tests own persistence/export contracts.
beforeEach(() => {
  vi.spyOn(nativeProcesses, 'readObsNativeProcesses').mockResolvedValue([]);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function directory() {
  const dir = await mkdtemp(join(await filesystem.realpath(tmpdir()), 'mizar-support-'));
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
  it('exports previous business sessions after restart without leaking private fields', async () => {
    // Keep host process discovery deterministic while exercising real business log persistence and redaction.
    vi.spyOn(nativeProcesses, 'readObsNativeProcesses').mockResolvedValue([]);
    const dir = await directory();
    const first = buildApp({ supportLogsDirectory: dir, gsiToken: 'PRIVATE-GSI-TOKEN' });
    await first.ready();
    for (let index = 0; index < 50; index++) {
      const response = await first.inject({
        method: 'POST',
        url: '/gsi',
        payload: {
          auth: { token: 'PRIVATE-GSI-TOKEN' },
          map: {
            name: 'de_ancient',
            phase: 'live',
            round: 0,
            team_ct: { score: 0 },
            team_t: { score: 0 },
          },
        },
      });
      expect(response.statusCode).toBe(204);
    }
    await first.inject(request);
    const beforeRestart = readBusinessHistory(dir)
      .groups.flatMap((g) => g.events)
      .filter((e) => e.stage === 'business_runtime');
    expect(beforeRestart.length).toBeLessThan(10);
    expect(
      beforeRestart.some(
        (event) => event.evidence.telemetry === 'fresh' && event.evidence.mapName === 'de_ancient',
      ),
    ).toBe(true);
    await first.close();
    const second = buildApp({ supportLogsDirectory: dir });
    try {
      const response = await second.inject(request);
      expect(response.statusCode).toBe(200);
      const bundle = response.json<{
        snapshot: { businessLog: string };
        businessHistory: ReturnType<typeof readBusinessHistory>;
      }>();
      expect(bundle.snapshot.businessLog).toBe('available');
      const systemEvents = unpack(response.json<FullArchive>(), 'session.ndjson')
        .filter((event) => event.stage === 'business_evidence')
        .map(
          (event) =>
            event.evidence as unknown as {
              stage: string;
              evidence: { telemetry?: string; mapName?: string };
            },
        );
      expect(
        systemEvents.some(
          (event) =>
            event.stage === 'business_runtime' &&
            event.evidence.telemetry === 'fresh' &&
            event.evidence.mapName === 'de_ancient',
        ),
      ).toBe(true);
      const events = bundle.businessHistory.groups.flatMap((g) => g.events);
      expect(
        new Set(events.filter((e) => e.stage === 'business_session').map((e) => e.startupSessionId))
          .size,
      ).toBe(2);
      expect(events.filter((e) => e.stage === 'business_runtime').length).toBeGreaterThan(2);
      expect(response.body).not.toContain('PRIVATE-GSI-TOKEN');
      await writeFile(
        join(dir, 'business.ndjson'),
        `${JSON.stringify({ event: 'business', stage: 'business_runtime', error: 'PRIVATE-TOP-LEVEL', err: { message: 'PRIVATE-ERROR' }, evidence: { identity: 'mismatch', issues: ['map_mismatch', 'PRIVATE-NAME'], token: 'PRIVATE-TOKEN', steam64: '76561199999999999', matchRef: 'a'.repeat(24), mapName: 'PRIVATE-SERVER' } })}\n`,
      );
      const sanitized = (await second.inject(request)).body;
      expect(sanitized).toContain('map_mismatch');
      const legacy = (await readSupportLogs(dir)).find((log) => log.name === 'business.ndjson')!
        .events[0]!.business;
      expect(legacy).toMatchObject({ schema: 1, matchRef: 'a'.repeat(24), matchId: null });
      for (const secret of [
        'PRIVATE-NAME',
        'PRIVATE-TOKEN',
        '76561199999999999',
        'PRIVATE-MATCH',
        'PRIVATE-SERVER',
        'PRIVATE-TOP-LEVEL',
        'PRIVATE-ERROR',
      ])
        expect(sanitized).not.toContain(secret);
    } finally {
      await second.close();
    }
  });

  it('reserves fault history from ordinary noise, bounds per-match/global retention and reports omissions', async () => {
    const dir = await directory();
    await writeFile(join(dir, BUSINESS_HISTORY_FILE + '.tmp'), 'interrupted-uncommitted-CANARY');
    const journal = new BusinessJournal(dir, () => {});
    await journal.flush();
    expect(readBusinessHistory(dir).manifest.abandonedStagingFiles).toBe(1);
    await expect(stat(join(dir, BUSINESS_HISTORY_FILE + '.tmp'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(await readFile(join(dir, BUSINESS_HISTORY_FILE), 'utf8')).not.toContain(
      'interrupted-uncommitted-CANARY',
    );
    journal.write('business_runtime', {
      matchId: 'match-one',
      liveSessionId: 'session-one',
      identity: 'matched',
      coverage: { allPlayers: 'present' },
      expected: [{ steam64: '76561199999999999', isStarter: true }],
      observed: [{ steam64: '76561199999999999', side: 'CT', slot: 0 }],
    });
    journal.write('business_claim', {
      matchId: 'match-one',
      liveSessionId: 'session-one',
      reason: 'http_403',
    });
    // Ordinary delivery events retain independent source versions, so bounded
    // batches exercise the real disk budget without 150 serial fsyncs.
    for (let runtimeSeq = 0; runtimeSeq < 150; runtimeSeq++) {
      journal.write('business_delivery', {
        matchId: 'match-one',
        liveSessionId: 'session-one',
        reason: 'receiver_accepted',
        runtimeSeq,
        expected: Array.from({ length: 64 }, () => ({
          steam64: '76561199999999999',
          entryId: 'entry-one',
        })),
      });
      if (runtimeSeq % 16 === 15) await journal.flush();
    }
    await journal.flush();
    const history = readBusinessHistory(dir);
    expect(history.manifest.rotatedEvents).toBeGreaterThan(0);
    expect(history.manifest.droppedPendingEvents).toBe(0);
    expect(
      history.groups
        .find((g) => g.matchId === 'match-one')
        ?.events.some((e) => e.evidence.reason === 'http_403'),
    ).toBe(true);
    const retainedFault = history.groups
      .find((g) => g.matchId === 'match-one')!
      .events.find((e) => e.evidence.reason === 'http_403')!;
    expect(retainedFault.context?.runtime?.evidence).toMatchObject({
      identity: 'matched',
      coverage: { allPlayers: 'present' },
      expected: [{ steam64: '76561199999999999' }],
      observed: [{ steam64: '76561199999999999' }],
    });
    expect((await stat(join(dir, BUSINESS_HISTORY_FILE))).size).toBeLessThanOrEqual(
      BUSINESS_HISTORY_LIMITS.totalBytes,
    );
    const clipped = readBusinessHistory(dir, 10);
    expect(clipped.groups).toEqual([]);
    expect(clipped.manifest.exportOmittedEvents).toBeGreaterThan(0);
    for (let i = 0; i < 18; i++)
      journal.write('business_claim', {
        matchId: `match-${i}`,
        liveSessionId: `session-${i}`,
        reason: 'claim_rejected',
      });
    await journal.flush();
    expect(readBusinessHistory(dir).manifest.rotatedGroups).toBeGreaterThan(0);
    expect(readBusinessHistory(dir).groups.length).toBeLessThanOrEqual(16);
    const blocked = join(dir, 'blocked');
    await writeFile(blocked, 'file');
    const failed = new BusinessJournal(blocked, () => {
      throw new Error('optional logger failure');
    });
    await failed.close();
    expect(failed.getStatus()).toBe('write_failed');
    expect(failed.getHealth().writeFailures).toBeGreaterThan(0);
  });

  it('filters secret canaries before disk and again during export, preserving only useful account identifiers', async () => {
    const dir = await directory();
    const journal = new BusinessJournal(dir, () => {});
    const canary = 'CANARY-SECRET-281';
    journal.write('business_runtime', {
      matchId: 'match-281',
      liveSessionId: 'session-281',
      contextRevision: 'revision-281',
      expected: [
        {
          steam64: '76561199999999999',
          entryId: 'entry-a',
          playerId: 'player-a',
          isStarter: true,
          password: canary,
        },
      ],
      observed: [{ steam64: '76561199999999999', side: 'CT', slot: 0, nickname: canary }],
      token: canary,
      Authorization: `Bearer ${canary}`,
      Cookie: canary,
      pairingKey: canary,
      privateKey: canary,
      obsPassword: canary,
      url: `https://example.test/?token=${canary}`,
      directory: `C:\\Users\\${canary}`,
      config: { secret: canary },
    });
    const path = join(dir, BUSINESS_HISTORY_FILE);
    await journal.flush();
    const disk = await readFile(path, 'utf8');
    expect(disk).not.toContain(canary);
    expect(disk).toContain('76561199999999999');
    const app = buildApp({
      supportLogsDirectory: dir,
      readObsCaptureEvidence: () => Promise.reject(new Error('synthetic unavailable')),
    });
    await app.ready();
    // A tampered local history is untrusted too; do not simply copy it to the bundle.
    const raw = JSON.parse(disk) as {
      groups: {
        events: { password?: string; evidence: { cookie?: string; matchId?: string } }[];
      }[];
    };
    raw.groups[0]!.events[0]!.password = canary;
    raw.groups[0]!.events[0]!.evidence.cookie = canary;
    raw.groups[0]!.events[0]!.evidence.matchId = `https://example.test/?token=${canary}`;
    await writeFile(path, JSON.stringify(raw));
    try {
      const response = await app.inject(request);
      expect(response.statusCode).toBe(200);
      expect(response.body).not.toContain(canary);
      expect(response.body).toContain('76561199999999999');
      expect(Buffer.byteLength(response.body)).toBeLessThanOrEqual(1024 * 1024);
    } finally {
      await app.close();
    }
    const exported = readBusinessHistory(dir);
    expect(JSON.stringify(exported)).not.toContain(canary);
    expect(
      exported.groups
        .flatMap((g) => g.events)
        .some((e) => e.evidence.expected.some((p) => p.steam64 === '76561199999999999')),
    ).toBe(true);
    raw.groups.push({ events: null } as unknown as (typeof raw.groups)[number]);
    const withBadGroup = JSON.stringify(raw);
    await writeFile(path, withBadGroup);
    const isolated = readBusinessHistory(dir);
    expect(isolated.manifest).toMatchObject({
      status: 'partial_corrupt',
      corruptGroups: 1,
      corruptRecords: null,
    });
    expect(isolated.groups.some((g) => g.matchId === 'match-281')).toBe(true);
    const blockedWriter = new BusinessJournal(dir, () => {});
    await blockedWriter.close();
    expect(await readFile(path, 'utf8')).toBe(withBadGroup);
    raw.groups.pop();
    raw.groups[0]!.events.push({ evidence: {}, password: canary });
    await writeFile(path, JSON.stringify(raw));
    expect(readBusinessHistory(dir).manifest).toMatchObject({
      status: 'partial_corrupt',
      corruptRecords: 1,
    });
    expect(JSON.stringify(readBusinessHistory(dir))).not.toContain(canary);
    await writeFile(path, '{broken');
    expect(readBusinessHistory(dir).manifest.status).toBe('unreadable_or_corrupt');
    const restarted = new BusinessJournal(dir, () => {});
    expect(restarted.getStatus()).toBe('write_failed');
    expect(await readFile(path, 'utf8')).toBe('{broken');
  });

  it('distinguishes claim denial, request failure, pending start ACK, retry and receiver acknowledgement in one retained chain', async () => {
    const dir = await directory();
    const journal = new BusinessJournal(dir, () => {});
    const credential = 'CANARY-CREDENTIAL-281';
    const path = join(dir, 'connection.json');
    await writeFile(
      path,
      JSON.stringify({
        baseUrl: OFFICIAL_RIVALHUB_URL,
        credential,
        installationId: 'installation-281',
        competitionId: 'competition-281',
        displayName: 'CANARY-PRIVATE-NAME',
      }),
    );
    let outcome: 'deny' | 'contended' | 'offline' | 'invalid' | 'claim' | 'retry' | 'accept' =
      'deny';
    const fetchImpl = vi.fn<typeof fetch>((url) => {
      const requestUrl = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
      if (outcome === 'offline')
        throw new TypeError(`https://user:${credential}@private.example?token=${credential}`);
      if (outcome === 'deny')
        return Promise.resolve(
          new Response(JSON.stringify({ password: credential }), { status: 403 }),
        );
      if (outcome === 'invalid') return Promise.resolve(new Response('{invalid-' + credential));
      if (outcome === 'contended')
        return Promise.resolve(
          Response.json({
            claimed: false,
            authorityRevision: 7,
            activeDeviceName: 'CANARY-PRIVATE-NAME',
          }),
        );
      if (requestUrl.endsWith('/claim'))
        return Promise.resolve(Response.json({ claimed: true, authorityRevision: 7 }));
      if (outcome === 'retry') return Promise.resolve(new Response(null, { status: 503 }));
      if (requestUrl.endsWith('/live')) return Promise.resolve(Response.json({ accepted: true }));
      return Promise.resolve(new Response(null, { status: 204 }));
    });
    const connection = new RivalHubConnection(path, fetchImpl);
    const rawLiveEvidence: unknown[] = [];
    const originalErrors: unknown[] = [];
    connection.setBusinessEvidenceHandler((stage, evidence) => {
      if (stage === 'business_live') rawLiveEvidence.push(evidence);
      if (stage === 'original_error') originalErrors.push(evidence);
      journal.write(stage, evidence);
    });
    await connection.load();
    const snapshot = {
      matchId: 'match-281',
      competitionId: 'competition-281',
      cursor: {
        producerInstanceId: 'producer-281',
        liveSessionId: 'session-281',
        programSourceGeneration: 2,
        mapEpoch: 3,
        runtimeSeq: 10,
        programReceiveSequence: 9,
      },
      players: [],
    } as unknown as LiveSnapshotV1;
    await expect(connection.claim(snapshot, 'revision-281', false)).rejects.toThrow();
    outcome = 'contended';
    await connection.claim(snapshot, 'revision-281', false);
    outcome = 'offline';
    await expect(connection.claim(snapshot, 'revision-281', false)).rejects.toThrow();
    outcome = 'invalid';
    await expect(connection.claim(snapshot, 'revision-281', false)).rejects.toThrow();
    outcome = 'claim';
    await connection.claim(snapshot, 'revision-281', false);
    await expect(connection.sendLive(snapshot)).rejects.toThrow('rivalhub_map_start_pending');
    const event = {
      kind: 'map_started',
      matchId: 'match-281',
      cursor: snapshot.cursor,
      idempotencyKey: 'start-281',
      observedAt: '2026-10-16T00:00:00.000Z',
    } as ReliableEventV1;
    outcome = 'retry';
    expect(await connection.sendReliable(event, snapshot)).toBe('retry');
    outcome = 'accept';
    expect(await connection.sendReliable(event, snapshot)).toBe('accepted');
    await connection.sendLive(snapshot);
    expect(rawLiveEvidence).toContainEqual(
      expect.objectContaining({
        reason: 'receiver_accepted',
        httpStatus: 200,
        serverDate: null,
        map: snapshot.map,
        capability: snapshot.capability,
        cursor: snapshot.cursor,
        receiptScope: 'ingestion acceptance only; website viewer validation/render is not observed',
      }),
    );
    await journal.flush();
    const events = readBusinessHistory(dir).groups.find((g) => g.matchId === 'match-281')!.events;
    const reasons = events.map((e) => e.evidence.reason);
    expect(reasons).toEqual(
      expect.arrayContaining([
        'claim_attempt',
        'http_403',
        'network_failed',
        'claim_accepted',
        'claim_rejected',
        'invalid_response',
        'map_start_pending',
        'http_503',
        'receiver_accepted',
      ]),
    );
    const ack = events.find(
      (e) => e.stage === 'business_reliable' && e.evidence.reason === 'receiver_accepted',
    )!;
    expect(ack.evidence.idempotencyKey).toBe('start-281');
    expect(ack.evidence.acknowledgedAt).not.toBeNull();
    expect(
      events.some((e) => e.stage === 'business_live' && e.evidence.reason === 'receiver_accepted'),
    ).toBe(true);
    expect(JSON.stringify(originalErrors)).toContain('private.example');
    expect(JSON.stringify(originalErrors)).toContain('TypeError');
    expect(JSON.stringify(originalErrors)).toContain('SyntaxError');
    expect(JSON.stringify(originalErrors)).not.toContain(credential);
    const disk = await readFile(join(dir, BUSINESS_HISTORY_FILE), 'utf8');
    for (const text of [disk, JSON.stringify(readBusinessHistory(dir))]) {
      expect(text).not.toContain(credential);
      expect(text).not.toContain('CANARY-PRIVATE-NAME');
      expect(text).not.toContain('private.example');
    }
  });

  it('contains invalid remote JSON at the actual claim route, disk logger and final HTTP bundle', async () => {
    const dir = await directory();
    const canary = 'n8Q4z281';
    const connectionPath = join(dir, 'connection.json');
    await writeFile(
      connectionPath,
      JSON.stringify({
        baseUrl: OFFICIAL_RIVALHUB_URL,
        credential: canary,
        installationId: 'installation-281',
        competitionId: 'competition-281',
        displayName: 'synthetic',
      }),
    );
    const journal = new BusinessJournal(dir, () => {});
    let rootCode = 'ECONNREFUSED';
    let mode: 'json' | 'network' | 'read' | 'root' = 'json';
    const connection = new RivalHubConnection(connectionPath, () => {
      if (mode === 'root')
        throw new TypeError(canary, {
          cause: Object.assign(new Error(canary), { code: rootCode }),
        });
      if (mode === 'network')
        throw new TypeError('https://user:' + canary + '@synthetic.example/?key=' + canary);
      if (mode === 'read')
        return Promise.resolve(
          new Response(
            new ReadableStream({
              start(controller) {
                controller.error(new TypeError(canary));
              },
            }),
          ),
        );
      return Promise.resolve(new Response(canary, { status: 200 }));
    });
    connection.setBusinessEvidenceHandler((stage, evidence) => journal.write(stage, evidence));
    await connection.load();
    const stream = createWriteStream(join(dir, 'companion.log'));
    const routes = Fastify({ logger: { stream } });
    const snapshot = {
      matchId: 'match-281',
      competitionId: 'competition-281',
      cursor: {
        producerInstanceId: 'producer-281',
        liveSessionId: 'session-281',
        programSourceGeneration: 2,
        mapEpoch: 3,
      },
      capability: { identity: 'matched', telemetryFresh: true, contextFresh: true },
      players: Array.from({ length: 10 }, (_, index) => ({
        lineupEvidence: 'current',
        sourcePlayerId: String(76561198000000000n + BigInt(index)),
      })),
    } as unknown as LiveSnapshotV1;
    registerRivalHubConnectionRoutes(routes, {
      connection,
      canClaim: () => true,
      controller: {
        getActiveBinding: () => ({
          origin: 'online',
          context: { matchId: 'match-281' },
          manifest: {
            revision: 'revision-281',
            match: { competition: { competitionId: 'competition-281' } },
          },
        }),
      } as unknown as MatchContextController,
      currentSnapshot: () => snapshot,
      originPolicy: {
        mode: 'loopback',
        bindHost: '127.0.0.1',
        allowedOrigins: ['http://127.0.0.1:3000'],
      },
    });
    try {
      const response = await routes.inject({
        method: 'POST',
        url: '/operator/rivalhub/source/claim',
        headers: { origin: 'http://127.0.0.1:3000' },
        payload: {},
      });
      expect(response.statusCode).toBe(409);
      expect(response.body).not.toContain(canary);
      mode = 'network';
      const failed = await routes.inject({
        method: 'POST',
        url: '/operator/rivalhub/source/claim',
        headers: { origin: 'http://127.0.0.1:3000' },
        payload: {},
      });
      expect(failed.statusCode).toBe(409);
      expect(failed.body).not.toContain(canary);
      mode = 'read';
      const readFailure = await routes.inject({
        method: 'POST',
        url: '/operator/rivalhub/source/claim',
        headers: { origin: 'http://127.0.0.1:3000' },
        payload: {},
      });
      expect(readFailure.statusCode).toBe(409);
      expect(readFailure.body).not.toContain(canary);
      mode = 'root';
      for (const code of ['ECONNREFUSED', 'ENOTFOUND']) {
        rootCode = code;
        const failedRoot = await routes.inject({
          method: 'POST',
          url: '/operator/rivalhub/source/claim',
          headers: { origin: 'http://127.0.0.1:3000' },
          payload: {},
        });
        expect(failedRoot.statusCode).toBe(409);
        expect(failedRoot.body).not.toContain(canary);
        await journal.flush();
        const persisted = readBusinessHistory(dir)
          .groups.flatMap((g) => g.events)
          .filter((e) => e.stage === 'business_claim' && e.evidence.reason === 'network_failed');
        expect(persisted.at(-1)?.evidence.causeCode).toBe(code);
        expect(await readFile(join(dir, BUSINESS_HISTORY_FILE), 'utf8')).not.toContain(canary);
      }
      // An arbitrary code cannot smuggle a credential through the new field.
      rootCode = canary;
      expect(
        (
          await routes.inject({
            method: 'POST',
            url: '/operator/rivalhub/source/claim',
            headers: { origin: 'http://127.0.0.1:3000' },
            payload: {},
          })
        ).statusCode,
      ).toBe(409);
    } finally {
      await routes.close();
      await journal.close();
      await new Promise<void>((resolve) => stream.end(resolve));
    }
    const disk = await readFile(join(dir, 'companion.log'), 'utf8');
    expect(disk).toContain('RIVALHUB_INVALID_JSON');
    expect(disk).toContain('RIVALHUB_RESPONSE_READ_FAILED');
    const rootCodes = disk
      .split('\n')
      .filter(Boolean)
      .map((line) => (JSON.parse(line) as { err?: { rootCauseCode?: string } }).err?.rootCauseCode)
      .filter(Boolean);
    expect(new Set(rootCodes)).toEqual(new Set(['ECONNREFUSED', 'ENOTFOUND']));
    expect(disk).not.toContain(canary);
    const support = buildApp({
      supportLogsDirectory: dir,
      readObsCaptureEvidence: () => Promise.reject(new Error('synthetic unavailable')),
    });
    try {
      const response = await support.inject(request);
      expect(response.statusCode).toBe(200);
      expect(response.body).not.toContain(canary);
      expect(response.body).toContain('RIVALHUB_INVALID_JSON');
      const exported = response.json<{
        businessHistory: ReturnType<typeof readBusinessHistory>;
        logs: { events: { localDiagnostic?: { rootCauseCode?: string } }[] }[];
      }>();
      const claimCodes = exported.businessHistory.groups
        .flatMap((g) => g.events)
        .filter((e) => e.stage === 'business_claim' && e.evidence.causeCode !== null)
        .map((e) => e.evidence.causeCode);
      expect(claimCodes).toEqual(['ECONNREFUSED', 'ENOTFOUND']);
      const exportedLogCodes = exported.logs
        .flatMap((log) => log.events)
        .map((e) => e.localDiagnostic?.rootCauseCode)
        .filter(Boolean);
      expect(new Set(exportedLogCodes)).toEqual(new Set(['ECONNREFUSED', 'ENOTFOUND']));
    } finally {
      await support.close();
    }
  });

  it('aggregates 150 successful LIVE frames while retaining the failed frame and its roster/coverage/guard evidence', async () => {
    const dir = await directory();
    const journal = new BusinessJournal(dir, () => {});
    const ids = Array.from({ length: 10 }, (_, i) => '7656119800000000' + String(i));
    const scope = {
      matchId: 'match-live',
      liveSessionId: 'session-live',
      producerInstanceId: 'producer-live',
    };
    journal.write('business_runtime', {
      ...scope,
      identity: 'matched',
      coverage: { map: 'present', allPlayers: 'present' },
      expected: ids.map((steam64) => ({ steam64, isStarter: true })),
      observed: ids.map((steam64, i) => ({ steam64, side: i < 5 ? 'CT' : 'T', slot: i })),
    });
    journal.write('business_guard', {
      ...scope,
      reason: 'send_guard_blocked',
      blockers: ['telemetry_not_fresh'],
    });
    journal.write('business_live', {
      ...scope,
      reason: 'network_failed',
      originalObservedAt: '2026-10-16T00:00:00.000Z',
    });
    await journal.flush();
    const initialWrites = journal.getHealth().committedWrites;
    for (let i = 1; i <= 150; i++)
      journal.write('business_live', {
        ...scope,
        reason: 'receiver_accepted',
        originalObservedAt: new Date(
          Date.parse('2026-10-16T00:00:00.000Z') + i * 500,
        ).toISOString(),
      });
    await journal.close();
    const history = readBusinessHistory(dir);
    const events = history.groups.find((g) => g.matchId === 'match-live')!.events;
    const failed = events.find((e) => e.evidence.reason === 'network_failed')!;
    expect(failed.context?.runtime?.evidence.expected.map((p) => p.steam64)).toEqual(ids);
    expect(failed.context?.runtime?.evidence.observed.map((p) => p.steam64)).toEqual(ids);
    expect(failed.context?.runtime?.evidence.coverage).toMatchObject({
      map: 'present',
      allPlayers: 'present',
    });
    expect(failed.context?.guard?.evidence.blockers).toContain('telemetry_not_fresh');
    const successes = events.filter(
      (e) => e.stage === 'business_live' && e.evidence.reason === 'receiver_accepted',
    );
    expect(successes).toHaveLength(1);
    expect(successes[0]).toMatchObject({
      occurrences: 150,
      lastObservedAt: '2026-10-16T00:01:15.000Z',
    });
    expect(journal.getHealth().committedWrites - initialWrites).toBe(1);
    expect(history.manifest.coalescedEvents).toBeGreaterThanOrEqual(149);
  });

  it('reports uncommitted write failures in the HTTP manifest and persists them after storage recovers', async () => {
    const dir = await directory();
    const app = buildApp({
      supportLogsDirectory: dir,
      gsiToken: 'synthetic-gsi',
      readObsCaptureEvidence: () => Promise.reject(new Error('synthetic unavailable')),
    });
    const originalRename = filesystem.rename;
    let failing = true;
    try {
      await app.ready();
      vi.spyOn(filesystem, 'rename').mockImplementation((source, target) =>
        String(source).endsWith(BUSINESS_HISTORY_FILE + '.tmp') && failing
          ? Promise.reject(Object.assign(new Error('synthetic denied'), { code: 'EACCES' }))
          : originalRename(source, target),
      );
      await app.inject({
        method: 'POST',
        url: '/gsi',
        payload: {
          auth: { token: 'synthetic-gsi' },
          map: {
            name: 'de_nuke',
            phase: 'live',
            round: 0,
            team_ct: { score: 0 },
            team_t: { score: 0 },
          },
        },
      });
      const response = await app.inject(request);
      const result = response.json<{
        businessHistory: ReturnType<typeof readBusinessHistory> & {
          manifest: { currentWriteStatus: string; uncommittedEvents: number };
        };
      }>();
      expect(result.businessHistory.manifest).toMatchObject({
        currentWriteStatus: 'write_failed',
        committedWriteFailures: 0,
        evidenceSource: 'committed_disk',
      });
      expect(result.businessHistory.manifest.writeFailures).toBeGreaterThan(0);
      expect(result.businessHistory.manifest.uncommittedWriteFailures).toBeGreaterThan(0);
      expect(result.businessHistory.manifest.uncommittedEvents).toBeGreaterThan(0);
      expect(
        result.businessHistory.groups
          .flatMap((g) => g.events)
          .some((e) => e.evidence.mapName === 'de_nuke'),
      ).toBe(false);
      failing = false;
      const recovered = (await app.inject(request)).json<typeof result>();
      expect(recovered.businessHistory.manifest).toMatchObject({
        currentWriteStatus: 'available',
        uncommittedWriteFailures: 0,
        uncommittedEvents: 0,
      });
      expect(recovered.businessHistory.manifest.committedWriteFailures).toBeGreaterThan(0);
      expect(
        recovered.businessHistory.groups
          .flatMap((g) => g.events)
          .some((e) => e.evidence.mapName === 'de_nuke'),
      ).toBe(true);
    } finally {
      failing = false;
      await app.close();
    }
  });

  it('bounds the pending queue and keeps accepting telemetry while the asynchronous fsync is held', async () => {
    const dir = await directory();
    const journal = new BusinessJournal(dir, () => {});
    await journal.flush();
    const appDir = await directory();
    const app = buildApp({ supportLogsDirectory: appDir, gsiToken: 'synthetic-gsi' });
    await app.ready();
    const originalOpen = filesystem.open;
    let release: () => void = () => {};
    let held = false;
    let appHeld = false;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(filesystem, 'open').mockImplementation(async (...args) => {
      const handle = await originalOpen(...args);
      if (String(args[0]).endsWith(BUSINESS_HISTORY_FILE + '.tmp')) {
        const sync = handle.sync.bind(handle);
        vi.spyOn(handle, 'sync').mockImplementation(async () => {
          held = true;
          if (args[0] === join(appDir, BUSINESS_HISTORY_FILE + '.tmp')) appHeld = true;
          await gate;
          await sync();
        });
      }
      return handle;
    });
    journal.write('business_live', { matchId: 'async-match', reason: 'network_failed' });
    const writing = journal.flush();
    try {
      await vi.waitFor(() => expect(held).toBe(true));
      for (let i = 0; i < 500; i++)
        journal.write('business_delivery', {
          matchId: 'async-match',
          idempotencyKey: 'event-' + i,
          reason: 'retry_unknown',
          attempts: i,
        });
      expect(journal.getHealth().queuedEvents).toBeLessThanOrEqual(
        BUSINESS_HISTORY_LIMITS.queuedEvents,
      );
      expect(journal.getHealth().queuedBytes).toBeLessThanOrEqual(
        BUSINESS_HISTORY_LIMITS.queuedBytes,
      );
      const frame = (name: string) => ({
        method: 'POST' as const,
        url: '/gsi',
        payload: { auth: { token: 'synthetic-gsi' }, map: { name } },
      });
      expect((await app.inject(frame('de_ancient'))).statusCode).toBe(204);
      await vi.waitFor(() => expect(appHeld).toBe(true));
      // Its own history fsync is still held: ingress must nevertheless finish.
      expect((await app.inject(frame('de_nuke'))).statusCode).toBe(204);
    } finally {
      release();
      await writing;
      await journal.close();
      await app.close();
    }
    expect(readBusinessHistory(dir).manifest.droppedPendingEvents).toBeGreaterThan(0);
  });

  it.skipIf(process.platform === 'win32')('rejects symlink log targets', async () => {
    const dir = await directory();
    await writeFile(
      join(dir, 'secret'),
      JSON.stringify({ stage: 'main_window', result: 'success' }),
    );
    await symlink(join(dir, 'secret'), join(dir, 'desktop.ndjson'));
    await symlink(join(dir, 'secret'), join(dir, BUSINESS_HISTORY_FILE));
    expect(readBusinessHistory(dir).manifest.status).toBe('unreadable_or_corrupt');
    expect(new BusinessJournal(dir, () => {}).getStatus()).toBe('write_failed');
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

type FullArchive = {
  sessionLogHealth: { writeFailures: number };
  fullLogs: {
    range: unknown;
    fragmentedDetails: unknown;
    focus: { componentSessions: string[] };
    files: {
      name: string;
      status: string;
      durability?: string;
      automaticDelivery?: { blocked: boolean; reason?: string };
      sha256?: string;
      volumes: { index: number; bytes: number; sha256: string; gzipBase64: string }[];
    }[];
  };
};
function unpack(bundle: FullArchive, prefix: string) {
  return bundle.fullLogs.files
    .filter((file) => file.name.startsWith(prefix) && file.status === 'read')
    .flatMap((file) => {
      const bytes = Buffer.concat(
        file.volumes.map((volume, index) => {
          expect(volume.index).toBe(index);
          const part = gunzipSync(Buffer.from(volume.gzipBase64, 'base64'));
          expect(part.length).toBe(volume.bytes);
          expect(createHash('sha256').update(part).digest('hex')).toBe(volume.sha256);
          return part;
        }),
      );
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(file.sha256);
      return bytes
        .toString('utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map(
          (line) =>
            JSON.parse(line) as {
              stage: string;
              startupSessionId: string;
              writeFailuresBefore: number;
              requestId?: string;
              browserOperationId?: string | null;
              evidence: {
                [key: string]: unknown;
                route?: string;
                requestId?: string;
                filename?: string;
                parameters?: unknown;
                httpStatus?: number;
                result?: unknown;
                after?: { config: { groups: { waiting: { tracks: { id: string }[] } } } };
                error?: { name: string; message: string; stack: string; cause: { name: string } };
                dropped?: number;
              };
            },
        );
    });
}

it('restores actual ingress and browser failure context from a complete bundle after restart', async () => {
  const dir = await directory();
  let now = 0;
  const first = buildApp({
    supportLogsDirectory: dir,
    gsiToken: 'private-fixture-token',
    debugClock: { nowMonotonicMs: () => now },
    clock: {
      now: () => ({ receivedMonotonicMs: now, receivedAt: new Date(now).toISOString() }),
    },
    onObservation: () => {
      if (now === 1500)
        throw new Error('observation callback failed', { cause: new Error('original sink cause') });
    },
  });
  const frame = async (health: number) => {
    const response = await first.inject({
      method: 'POST',
      url: '/gsi',
      payload: {
        auth: { token: 'private-fixture-token' },
        map: { name: 'de_ancient', phase: 'live', round: 1 },
        allplayers: {
          'public-player-fixture': {
            name: 'not-selected-for-context',
            position: '100,200,300',
            team: 'CT',
            state: { health },
          },
        },
      },
    });
    expect(response.statusCode).toBe(204);
  };
  try {
    for (now = 0; now <= 1000; now += 250) await frame(100);
    const response = await first.inject({
      method: 'POST',
      url: '/debug/control-event',
      headers: request.headers,
      payload: {
        operation: 'browser_error',
        phase: 'failure',
        time: new Date(now).toISOString(),
        browserDocumentId: 'public-browser-fixture',
        evidence: {
          error: {
            name: 'Error',
            message: 'drawing failed',
            cause: { name: 'IndexSizeError', message: 'negative radius; token=PRIVATE-SECRET' },
          },
        },
      },
    });
    expect(response.statusCode).toBe(204);
    now = 1500;
    await frame(17);
  } finally {
    await first.close();
  }
  const second = buildApp({ supportLogsDirectory: dir });
  try {
    const response = await second.inject(request);
    expect(response.statusCode).toBe(200);
    const records = unpack(response.json<FullArchive>(), 'session');
    const failure = records.find(
      (entry) => entry.stage === 'browser_control' && entry.evidence.operation === 'browser_error',
    );
    expect(failure?.evidence.evidence).toMatchObject({
      error: {
        name: 'Error',
        cause: { name: 'IndexSizeError', message: 'negative radius; token=[redacted]' },
      },
    });
    const begin = records.find((entry) => entry.stage === 'performance_anomaly_begin');
    expect(begin?.evidence).toMatchObject({
      reason: 'browser_anomaly',
      correlation: { browserDocumentId: 'public-browser-fixture' },
    });
    expect(records.find((entry) => entry.stage === 'telemetry_failure')?.evidence).toMatchObject({
      code: 'observation_sink_failed',
      receive: { sequence: 5 },
      error: { message: 'observation callback failed', cause: { message: 'original sink cause' } },
    });
    const chunks = records.filter((entry) => entry.stage === 'performance_anomaly_samples');
    const before = chunks
      .filter((entry) => entry.evidence.phase === 'before')
      .flatMap((entry) => entry.evidence.samples as { sequence: number; evidence: unknown }[]);
    const after = chunks
      .filter((entry) => entry.evidence.phase === 'after')
      .flatMap((entry) => entry.evidence.samples as { sequence: number; evidence: unknown }[]);
    expect(before.map((sample) => sample.sequence)).toEqual([0, 1, 2, 3, 4]);
    expect(after).toMatchObject([
      {
        sequence: 5,
        evidence: {
          input: { players: [{ state: { health: 17 } }] },
          normalizedBeforeCurrentRaw: { sequence: 4 },
        },
      },
    ]);
    expect(
      records.find((entry) => entry.stage === 'performance_anomaly_end')?.evidence,
    ).toMatchObject({
      reason: 'shutdown',
      postIncomplete: true,
      postSamples: 1,
    });
    expect(
      new Set(
        records
          .filter((entry) => entry.stage === 'session_start')
          .map((entry) => entry.startupSessionId),
      ).size,
    ).toBe(2);
    expect(JSON.stringify(records)).not.toContain('PRIVATE-SECRET');
    expect(JSON.stringify(chunks)).not.toContain('not-selected-for-context');
  } finally {
    await second.close();
  }
});

it('exports durable pending window originals during IO failure and restores them after restart in the original time range', async () => {
  const dir = await directory();
  let blocked = true;
  const originalOpen = filesystem.open;
  vi.spyOn(filesystem, 'open').mockImplementation(async (...args) => {
    const handle = await originalOpen(...args);
    if (String(args[0]) === join(dir, 'session.ndjson')) {
      const write = handle.writeFile.bind(handle);
      vi.spyOn(handle, 'writeFile').mockImplementation(async (data, options) => {
        if (blocked && typeof data === 'string' && data.includes('performance_anomaly_'))
          throw Object.assign(new Error('synthetic pending window IO failure'), { code: 'EBUSY' });
        await write(data, options);
      });
    }
    return handle;
  });
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime('2026-10-17T00:00:00.000Z');
  let first: ReturnType<typeof buildApp> | undefined;
  let second: ReturnType<typeof buildApp> | undefined;
  let now = 0;
  const headers = { origin: 'http://127.0.0.1:3000', 'content-type': 'application/json' };
  type WindowRecord = {
    stage?: string;
    time?: string;
    sourceRecordId?: string;
    evidence?: {
      sourceRecord?: { id: string; sessionId: string };
      samples?: {
        sequence: number;
        evidence: { input: { players: { state: { health: number } }[] } };
      }[];
      correlation?: { originalEvidence?: { error?: { cause?: { message: string } } } };
    };
  };
  const readActualBundle = async (body: string, name: string): Promise<WindowRecord[]> => {
    const path = join(dir, name + '.json');
    await writeFile(path, body);
    return execFileSync(process.execPath, ['scripts/diagnostics/read-support-bundle.mjs', path], {
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as WindowRecord);
  };
  try {
    first = buildApp({
      supportLogsDirectory: dir,
      gsiToken: 'public-io-token',
      debugClock: { nowMonotonicMs: () => now },
      clock: {
        now: () => ({
          receivedAt: new Date(Date.now() + now).toISOString(),
          receivedMonotonicMs: now,
        }),
      },
    });
    const address = await first.listen({ host: '127.0.0.1', port: 0 });
    for (let index = 0; index < 9; index++) {
      now = index * 250;
      if (index === 5) {
        const failure = await fetch(address + '/debug/control-event', {
          method: 'POST',
          headers,
          body: JSON.stringify({
            operation: 'browser_error',
            phase: 'failure',
            time: new Date().toISOString(),
            browserDocumentId: 'public-retry-document',
            evidence: {
              page: '/workspace',
              error: {
                name: 'IndexSizeError',
                message: 'negative radius',
                cause: { name: 'RangeError', message: 'original radius cause token=PRIVATE-IO' },
              },
            },
          }),
        });
        expect(failure.status).toBe(204);
      }
      const response = await fetch(address + '/gsi', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          auth: { token: 'public-io-token' },
          map: { name: 'de_ancient', phase: 'live', round: 1 },
          allplayers: {
            '76561198000000001': {
              position: '1,2,3',
              team: 'CT',
              state: { health: index < 5 ? 100 : 17 },
            },
          },
        }),
      });
      expect(response.status).toBe(204);
    }
    const pending = await fetch(address + '/debug/support-bundle', {
      method: 'POST',
      headers,
      body: '{}',
    });
    expect(pending.status).toBe(200);
    const pendingBody = await pending.text();
    const pendingBundle = JSON.parse(pendingBody) as FullArchive;
    expect(pendingBundle.fullLogs.files.some((file) => file.durability === 'durable-pending')).toBe(
      true,
    );
    const pendingRows = (await readActualBundle(pendingBody, 'pending-io-bundle')).filter(
      (row) => row.sourceRecordId,
    );
    expect(
      pendingRows.some(
        (row) =>
          row.evidence?.correlation?.originalEvidence?.error?.cause?.message ===
          'original radius cause token=[redacted]',
      ),
    ).toBe(true);
    const originalSession = pendingRows[0]!.evidence!.sourceRecord!.sessionId;
    const sourceIds = pendingRows.map((row) => row.sourceRecordId);
    expect(new Set(sourceIds).size).toBe(sourceIds.length);
    await first.close();
    blocked = false;
    vi.setSystemTime('2026-10-17T00:30:00.000Z');
    second = buildApp({ supportLogsDirectory: dir });
    const restartedAddress = await second.listen({ host: '127.0.0.1', port: 0 });
    const restored = await fetch(restartedAddress + '/debug/support-bundle', {
      method: 'POST',
      headers,
      body: JSON.stringify({ from: '2026-10-16T23:59:59.000Z', to: '2026-10-17T00:01:00.000Z' }),
    });
    expect(restored.status).toBe(200);
    const restoredBody = await restored.text();
    const rows = (await readActualBundle(restoredBody, 'restored-io-bundle')).filter(
      (row) => row.sourceRecordId,
    );
    expect(rows.map((row) => row.sourceRecordId)).toEqual(expect.arrayContaining(sourceIds));
    expect(new Set(rows.map((row) => row.sourceRecordId)).size).toBe(rows.length);
    expect(rows.every((row) => row.evidence?.sourceRecord?.sessionId === originalSession)).toBe(
      true,
    );
    const samples = rows.flatMap((row) => row.evidence?.samples ?? []);
    expect(new Set(samples.map((sample) => sample.sequence))).toEqual(
      new Set([0, 1, 2, 3, 4, 5, 6, 7, 8]),
    );
    expect(
      samples.some(
        (sample) => sample.sequence === 0 && sample.evidence.input.players[0]?.state.health === 100,
      ),
    ).toBe(true);
    expect(
      samples.some(
        (sample) => sample.sequence === 8 && sample.evidence.input.players[0]?.state.health === 17,
      ),
    ).toBe(true);
    expect(restoredBody).not.toContain('PRIVATE-IO');
  } finally {
    blocked = false;
    await first?.close();
    await second?.close();
    vi.useRealTimers();
  }
});

it(
  'reconstructs real 6 MiB MP3 upload, configuration, failure and restart from the production HTTP export',
  { timeout: 20_000 },
  async () => {
    const dir = await directory();
    const data = join(dir, 'data');
    await filesystem.mkdir(data);
    const logs = join(dir, 'logs');
    const options = { supportLogsDirectory: logs, obsConfigPath: join(data, 'obs.json') };
    const first = buildApp(options);
    const origin = 'http://127.0.0.1:3000';
    const taskId = '11111111-1111-4111-8111-111111111111';
    const parentOperationId = '22222222-2222-4222-8222-222222222222';
    const browserOperationId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    const frame = await readFile(new URL('./fixtures/diagnostic-tone.mp3', import.meta.url));
    const bytes = Buffer.concat(
      Array.from({ length: Math.ceil((6 * 1024 * 1024) / frame.length) }, () => frame),
    );
    let track: MusicTrack;
    try {
      const address = await first.listen({ host: '127.0.0.1', port: 0 });
      const upload = await fetch(`${address}/operator/music/track`, {
        method: 'POST',
        headers: {
          origin,
          'content-type': 'application/x-mizar-audio',
          'x-mizar-filename': encodeURIComponent('诊断合成音.mp3'),
          'x-mizar-operation-id': browserOperationId,
          'x-mizar-task-id': taskId,
          'x-mizar-parent-operation-id': parentOperationId,
          'x-mizar-trigger': 'user',
        },
        body: bytes,
      });
      expect(upload.status).toBe(200);
      track = (await upload.json()) as typeof track;
      expect(track.name).toBe('诊断合成音.mp3');
      expect((await readFile(join(data, 'music', 'tracks', track.id))).equals(bytes)).toBe(true);
      const current = (await (await fetch(`${address}/local/v1/music`)).json()) as {
        config: MusicConfig;
      };
      current.config.groups.waiting.tracks = [track];
      const save = await fetch(`${address}/operator/music`, {
        method: 'POST',
        headers: { origin, 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'configure', config: current.config }),
      });
      expect(save.status).toBe(200);
      for (let index = 0; index < 40; index++) {
        expect(
          (
            await fetch(`${address}/operator/music`, {
              method: 'POST',
              headers: { origin, 'content-type': 'application/json' },
              body: JSON.stringify({ action: 'volume', group: 'waiting', volume: index / 100 }),
            })
          ).status,
        ).toBe(200);
      }
      const invalid = await fetch(`${address}/operator/music/track`, {
        method: 'POST',
        headers: {
          origin,
          'content-type': 'application/x-mizar-audio',
          'x-mizar-filename': 'broken.mp3',
        },
        body: 'invalid media',
      });
      expect(invalid.status).toBe(400);
    } finally {
      await first.close();
    }
    const second = buildApp(options);
    try {
      const address = await second.listen({ host: '127.0.0.1', port: 0 });
      const restored = (await (await fetch(`${address}/local/v1/music`)).json()) as {
        config: MusicConfig;
      };
      expect(restored.config.groups.waiting.tracks[0]).toMatchObject(track!);
      expect(restored.config.groups.waiting.volume).toBe(0.39);
      const exported = await fetch(`${address}/debug/support-bundle`, {
        method: 'POST',
        headers: { origin, 'content-type': 'application/json' },
        body: '{}',
      });
      expect(exported.status).toBe(200);
      const bundle = (await exported.json()) as FullArchive;
      if (process.env.MIZAR_DIAGNOSTIC_EVIDENCE) {
        await filesystem.mkdir(process.env.MIZAR_DIAGNOSTIC_EVIDENCE, { recursive: true });
        await writeFile(
          join(process.env.MIZAR_DIAGNOSTIC_EVIDENCE, 'synthetic-http-restart-bundle.json'),
          JSON.stringify(bundle, null, 2),
        );
      }
      const events = unpack(bundle, 'session.ndjson');
      const begins = events.filter((event) => event.stage === 'operation_begin');
      expect(begins.filter((event) => event.evidence.route === '/operator/music')).toHaveLength(41);
      const upload = begins.find(
        (event) =>
          event.evidence.route === '/operator/music/track' &&
          event.evidence.filename !== 'broken.mp3',
      )!;
      expect(upload.evidence.parameters).toMatchObject({
        bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        content: 'binary-not-collected',
      });
      const successful = events.find(
        (event) =>
          event.stage === 'operation_result' &&
          event.evidence.requestId === upload.evidence.requestId &&
          event.startupSessionId === upload.startupSessionId,
      )!;
      expect(successful.evidence).toMatchObject({ httpStatus: 200, result: track! });
      const validated = events.find(
        (event) => event.stage === 'music_validate' && event.evidence.result === 'success',
      )!;
      expect(validated.requestId).toBe(upload.evidence.requestId);
      expect(validated.browserOperationId).toBe(browserOperationId);
      expect(validated).toMatchObject({ taskId, parentOperationId, trigger: 'user' });
      expect(
        events.some(
          (event) =>
            event.stage === 'music_commit_config' &&
            event.evidence.after!.config.groups.waiting.tracks[0]?.id === track!.id,
        ),
      ).toBe(true);
      const failure = events.find(
        (event) => event.stage === 'music_validate' && event.evidence.result === 'failure',
      )!;
      expect(failure.evidence.error).toMatchObject({
        name: 'Error',
        message: 'music_track_invalid',
      });
      expect(failure.evidence.error!.stack).toContain('MusicStore');
      expect(new Set(events.map((event) => event.startupSessionId)).size).toBe(2);
      expect(events.some((event) => event.stage === 'session_end')).toBe(true);
    } finally {
      await second.close();
    }
  },
);

it('exports initialization cause instead of an apparently healthy empty library and can reload after repair', async () => {
  const dir = await directory();
  const data = join(dir, 'data');
  await filesystem.mkdir(join(data, 'music'), { recursive: true });
  await writeFile(join(data, 'music', 'state.json'), '{ damaged');
  const app = buildApp({
    supportLogsDirectory: join(dir, 'logs'),
    obsConfigPath: join(data, 'obs.json'),
  });
  try {
    await app.ready();
    expect((await app.inject('/local/v1/music')).json<{ storage: unknown }>().storage).toEqual({
      ready: false,
      failed: true,
    });
    const rejected = await app.inject({
      method: 'POST',
      url: '/operator/music/track',
      headers: {
        origin: 'http://127.0.0.1:3000',
        'content-type': 'application/x-mizar-audio',
        'x-mizar-filename': 'valid.mp3',
      },
      payload: Buffer.from('ID3'),
    });
    expect(rejected.json<{ message: string }>().message).toContain('存储尚未就绪');
    const events = unpack((await app.inject(request)).json<FullArchive>(), 'session.ndjson');
    const failure = events.find(
      (event) => event.stage === 'music_load' && event.evidence.result === 'failure',
    )!;
    expect(failure.evidence.error!.message).toBe('music_state_invalid');
    expect(failure.evidence.error!.cause.name).toBe('SyntaxError');
    expect(await readFile(join(data, 'music', 'state.json'), 'utf8')).toBe('{ damaged');
    await filesystem.unlink(join(data, 'music', 'state.json'));
    const repaired = await app.inject({
      method: 'POST',
      url: '/operator/music',
      headers: { origin: 'http://127.0.0.1:3000' },
      payload: { action: 'reload' },
    });
    expect(repaired.statusCode).toBe(200);
    expect(repaired.json<{ storage: unknown }>().storage).toEqual({ ready: true, failed: false });
  } finally {
    await app.close();
  }
});

it('retains complete normal records in compressed volumes, exposes overload gaps and replaces only credentials', async () => {
  const dir = await directory();
  const journal = new SessionJournal(dir);
  for (let index = 0; index < 100; index++) {
    journal.record('control', {
      index,
      route: '/operator/example',
      password: 'PRIVATE-PASSWORD',
      config: { width: 1920, streamKey: 'PRIVATE-STREAM' },
      message: 'stage=write token=PRIVATE-TOKEN result=failed',
      error: new Error('wrapper', { cause: new Error('disk denied') }),
      payload: 'context'.repeat(2000),
    });
    if (index % 20 === 19) await journal.flush();
  }
  journal.record('overload', { bytes: 'x'.repeat(SESSION_LIMITS.pendingBytes + 1) });
  await journal.close();
  const app = buildApp({ supportLogsDirectory: dir });
  try {
    const events = unpack((await app.inject(request)).json<FullArchive>(), 'session.ndjson');
    expect(events.filter((e) => e.stage === 'control')).toHaveLength(100);
    const event = events.find((e) => e.stage === 'control')!;
    expect(event.evidence).toMatchObject({
      route: '/operator/example',
      password: '[redacted]',
      config: { width: 1920, streamKey: '[redacted]' },
      message: 'stage=write token=[redacted] result=failed',
      error: { message: 'wrapper', cause: { message: 'disk denied' } },
    });
    expect(events.find((e) => e.stage === 'session_end')!.evidence.dropped).toBe(1);
    expect(JSON.stringify(events)).not.toContain('PRIVATE-');
  } finally {
    await app.close();
  }
});

it('bounds rotated session storage, reports eviction and expiry, and honors an explicit export interval', async () => {
  const dir = await directory();
  const previous = { ...SESSION_LIMITS };
  Object.assign(SESSION_LIMITS, { segmentBytes: 4096, segments: 3 });
  try {
    const journal = new SessionJournal(dir);
    for (let index = 0; index < 12; index++) {
      journal.record('retention-fixture', { index, text: 'x'.repeat(2500) });
      await journal.flush();
    }
    await journal.close();
    const files = await filesystem.readdir(dir);
    const segments = files.filter((name) => /^session\.ndjson(?:\.\d+)?$/.test(name));
    expect(segments.length).toBeLessThanOrEqual(3);
    expect(
      (await Promise.all(segments.map((name) => stat(join(dir, name))))).reduce(
        (sum, value) => sum + value.size,
        0,
      ),
    ).toBeLessThanOrEqual(3 * 4096);
    expect(journal.health().retention.rotatedFiles).toBeGreaterThan(0);
    const old = new Date(Date.now() - 15 * 86400_000);
    for (const name of segments) await filesystem.utimes(join(dir, name), old, old);
    const next = new SessionJournal(dir);
    await next.close();
    expect(next.health().retention.expiredFiles).toBe(segments.length);
    expect(next.health().retention.rotatedFiles).toBeGreaterThan(0);
    const app = buildApp({ supportLogsDirectory: dir });
    try {
      const response = await app.inject({
        ...request,
        payload: { from: '2000-01-01T00:00:00.000Z', to: '2001-01-01T00:00:00.000Z' },
      });
      expect(response.statusCode).toBe(200);
      expect(unpack(response.json<FullArchive>(), 'session.ndjson')).toEqual([]);
      expect(response.json<FullArchive>().fullLogs.range).toEqual({
        from: '2000-01-01T00:00:00.000Z',
        to: '2001-01-01T00:00:00.000Z',
      });
    } finally {
      await app.close();
    }
  } finally {
    Object.assign(SESSION_LIMITS, previous);
  }
});

it('keeps the control response when session writes fail and exports the failure instead of inventing a persisted operation', async () => {
  const dir = await directory();
  const actualOpen = filesystem.open;
  const blocked = vi.spyOn(filesystem, 'open').mockImplementation((...args) => {
    if (String(args[0]).endsWith('session.ndjson'))
      return Promise.reject(Object.assign(new Error('disk denied'), { code: 'EACCES' }));
    return actualOpen(...args);
  });
  const app = buildApp({ supportLogsDirectory: dir });
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/operator/program-director',
      headers: { origin: 'http://127.0.0.1:3000' },
      payload: { action: 'invalid' },
    });
    expect(response.statusCode).toBe(400);
    const exported = await app.inject(request);
    expect(exported.statusCode).toBe(200);
    expect(exported.json<FullArchive>().sessionLogHealth.writeFailures).toBeGreaterThan(0);
    expect(unpack(exported.json<FullArchive>(), 'session.ndjson')).toEqual([]);
    blocked.mockRestore();
    const recovered = await app.inject({
      method: 'POST',
      url: '/operator/program-director',
      headers: { origin: 'http://127.0.0.1:3000' },
      payload: { action: 'invalid' },
    });
    expect(recovered.statusCode).toBe(400);
    const events = unpack((await app.inject(request)).json<FullArchive>(), 'session.ndjson');
    expect(events.some((event) => event.writeFailuresBefore > 0)).toBe(true);
  } finally {
    blocked.mockRestore();
    await app.close();
  }
});

it('exports newly named native stages without projection and detects missing long-error fragments in a selected interval', async () => {
  const dir = await directory();
  await writeFile(
    join(dir, 'desktop.ndjson.1'),
    JSON.stringify({
      startupSessionId: 'legacy-native-session',
      time: '2026-01-01T00:00:01.000Z',
      stage: 'legacy_control',
      result: 'success',
      detail: 'kept in full',
    }) + '\n',
  );
  const message = 'outer cause; ' + '技术原因'.repeat(3000) + '; leaf=EACCES';
  const event = (part: number, time: string, text: string) => ({
    startupSessionId: 'native-session',
    time,
    stage: 'new_native_failure_stage',
    result: 'failure',
    error: JSON.stringify({ detailId: 'native-detail-id', part, parts: 2, text }),
  });
  await writeFile(
    join(dir, 'desktop.1.ndjson'),
    JSON.stringify(event(1, '2026-01-01T00:00:00.000Z', message.slice(0, 6000))) + '\n',
  );
  await writeFile(
    join(dir, 'desktop.ndjson'),
    JSON.stringify(event(2, '2026-01-01T00:00:01.000Z', message.slice(6000))) + '\n',
  );
  const app = buildApp({ supportLogsDirectory: dir });
  try {
    const response = await app.inject(request);
    const bundle = response.json<FullArchive>();
    expect(bundle.fullLogs.fragmentedDetails).toContainEqual({
      id: 'native-detail-id',
      expected: 2,
      included: 2,
      complete: true,
    });
    const events = unpack(bundle, 'desktop.');
    expect(events.some((event) => event.stage === 'legacy_control')).toBe(true);
    expect(events.filter((event) => event.stage === 'new_native_failure_stage')).toHaveLength(2);
    const path = join(dir, 'export.json');
    await writeFile(path, response.body);
    const output = execFileSync(
      process.execPath,
      ['scripts/diagnostics/read-support-bundle.mjs', path],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const reconstructed = output
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { reconstructedDetail?: string })
      .find((event) => event.reconstructedDetail !== undefined);
    expect(reconstructed?.reconstructedDetail).toBe(message);
    const interval = await app.inject({
      ...request,
      payload: { from: '2026-01-01T00:00:00.500Z', to: '2026-01-01T00:00:02.000Z' },
    });
    expect(interval.json<FullArchive>().fullLogs.fragmentedDetails).toContainEqual({
      id: 'native-detail-id',
      expected: 2,
      included: 1,
      complete: false,
    });
  } finally {
    await app.close();
  }
});

it('focuses the Host session across restarts while retaining cross-process evidence for borrowed runtimes', async () => {
  const dir = await directory();
  for (const [host, operation] of [
    ['host-A', 'first'],
    ['host-A', 'restarted'],
    ['host-B', 'unrelated'],
  ] as const) {
    const journal = new SessionJournal(dir, { hostStartupSessionId: host });
    journal.record('host-linked-control', { operation });
    await journal.close();
  }
  await writeFile(
    join(dir, 'desktop.ndjson'),
    JSON.stringify({
      startupSessionId: 'host-A',
      schemaVersion: 1,
      time: new Date().toISOString(),
      stage: 'cs2_launch_arguments',
      result: 'begin',
      detail: '-applaunch 730 -worldwide',
    }) + '\n',
  );
  const app = buildApp({ supportLogsDirectory: dir });
  try {
    const response = await app.inject({ ...request, payload: { focusSessionId: 'host-A' } });
    expect(response.statusCode).toBe(200);
    const bundle = response.json<FullArchive>();
    const controls = unpack(bundle, 'session.ndjson').filter(
      (event) => event.stage === 'host-linked-control',
    );
    expect(controls.map((event) => event.evidence.operation)).toEqual([
      'first',
      'restarted',
      'unrelated',
    ]);
    expect(bundle.fullLogs.focus.componentSessions).toHaveLength(3);
    expect(new Set(controls.map((event) => event.startupSessionId)).size).toBe(3);
    expect(unpack(bundle, 'desktop.').some((event) => event.stage === 'cs2_launch_arguments')).toBe(
      true,
    );
    expect(JSON.stringify(controls)).toContain('unrelated');
  } finally {
    await app.close();
  }
  await appendFile(
    join(dir, 'desktop.ndjson'),
    JSON.stringify({
      schemaVersion: 1,
      startupSessionId: 'host-B',
      time: new Date().toISOString(),
      stage: 'workspace_exit_wait',
      result: 'waiting',
      detail: JSON.stringify({ stage: 'cs2_finish', elapsedSeconds: 5, terminalConfirmed: false }),
    }) + '\n',
  );
  const restarted = buildApp({ supportLogsDirectory: dir });
  try {
    const response = await restarted.inject(request);
    expect(response.statusCode).toBe(200);
    const records = unpack(response.json<FullArchive>(), 'session.ndjson');
    const native = records
      .filter((entry) => entry.stage === 'native_host_records')
      .flatMap(
        (record) =>
          record.evidence.entries as {
            sourceRecordId: string;
            entry: { startupSessionId: string; stage: string; detail: string };
          }[],
      );
    expect(native.map((record) => [record.entry.startupSessionId, record.entry.stage])).toEqual([
      ['host-A', 'cs2_launch_arguments'],
      ['host-B', 'workspace_exit_wait'],
    ]);
    expect(native[0]?.entry.detail).toContain('-worldwide');
    expect(JSON.parse(native[1]!.entry.detail)).toMatchObject({
      stage: 'cs2_finish',
      terminalConfirmed: false,
    });
    expect(new Set(native.map((record) => record.sourceRecordId)).size).toBe(2);
  } finally {
    await restarted.close();
  }
});

async function readRetainedTimeline(body: string, directory: string) {
  const path = join(directory, 'public-retained-export.json');
  await writeFile(path, body);
  return execFileSync(process.execPath, ['scripts/diagnostics/read-support-bundle.mjs', path], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

it('exports full unacknowledged outbox evidence over the production HTTP route after restart and source rotation', async () => {
  const dir = await directory();
  const journal = new SessionJournal(dir);
  let now = Date.now();
  const delivery = await new DiagnosticDelivery(dir, journal, { now: () => now }).initialize(false);
  await delivery.consent(true);
  journal.record('workspace_exit_failure', {
    phase: 'restore_window',
    actualArguments: ['-applaunch', '730', '-worldwide'],
    privateChat: 'synthetic-local-original-context',
    before: { workspace: 'active' },
    after: { workspace: 'waiting' },
    error: new Error('outer password=PRIVATE-RETAINED-PASSWORD', {
      cause: Object.assign(new Error('original retained restore denied'), { code: 'EACCES' }),
    }),
  });
  await journal.flush();
  await delivery.tick();
  const overlapping = await fullLogArchive(dir, {}, [], {
    outbox: await delivery.retainedBatches(),
  });
  const originalTimeline = await readRetainedTimeline(
    JSON.stringify({ schema: 'mizar-support-bundle/1', fullLogs: overlapping }),
    dir,
  );
  const originalEvents = originalTimeline
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { stage?: string; sourceDurability?: string });
  expect(originalEvents.filter((event) => event.stage === 'workspace_exit_failure')).toMatchObject([
    { sourceDurability: 'session-log' },
  ]);
  expect(originalTimeline).toContain('synthetic-local-original-context');
  now += 90 * 86400_000 + 1000;
  await delivery.tick();
  await delivery.close();
  await journal.close();
  const state = JSON.parse(await readFile(join(dir, 'diagnostic-outbox/state.json'), 'utf8')) as {
    credentials: { enrollmentSecret: string };
    queue: { id: string }[];
  };
  expect(state.queue.length).toBeGreaterThan(0);
  // The original producer history has legitimately aged out; the full unacknowledged copy remains.
  for (const name of await filesystem.readdir(dir))
    if (/^session\.ndjson(?:\.\d+)?$/.test(name)) await filesystem.unlink(join(dir, name));
  const app = buildApp({ supportLogsDirectory: dir });
  try {
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const response = await fetch(address + '/debug/support-bundle', {
      method: 'POST',
      headers: { ...request.headers, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).not.toContain(state.credentials.enrollmentSecret);
    const archive = JSON.parse(body) as FullArchive;
    expect(
      archive.fullLogs.files.some(
        (file) =>
          file.name.startsWith('diagnostic-outbox/') &&
          file.status === 'read' &&
          file.durability === 'durable-outbox' &&
          file.automaticDelivery?.reason === 'installation_lease_closed',
      ),
    ).toBe(true);
    const timeline = await readRetainedTimeline(body, dir);
    for (const value of [
      'original retained restore denied',
      'EACCES',
      '-worldwide',
      'restore_window',
      'waiting',
      'durable-outbox',
    ])
      expect(timeline).toContain(value);
    expect(timeline).not.toContain('PRIVATE-RETAINED-PASSWORD');
    expect(timeline).not.toContain(state.credentials.enrollmentSecret);
  } finally {
    await app.close();
  }
});

it('exports unconfirmed journal memory with its full error chain and prefers the broader original after recovery', async () => {
  const dir = await directory();
  const originalOpen = filesystem.open;
  let blocked = true;
  vi.spyOn(filesystem, 'open').mockImplementation(async (...args) => {
    const handle = await originalOpen(...args);
    if (String(args[0]) === join(dir, 'session.ndjson')) {
      const write = handle.writeFile.bind(handle);
      vi.spyOn(handle, 'writeFile').mockImplementation(async (data, options) => {
        if (blocked) {
          if (typeof data === 'string') await write(data.slice(0, 64), options);
          throw Object.assign(new Error('synthetic journal append EBUSY'), { code: 'EBUSY' });
        }
        await write(data, options);
      });
    }
    return handle;
  });
  const journal = new SessionJournal(dir);
  try {
    journal.record('music_config_failure', {
      phase: 'write',
      before: { track: 'valid.mp3' },
      error: new Error('outer', {
        cause: Object.assign(new Error('full original file failure'), { code: 'EACCES' }),
      }),
      privateChat: 'local-original-context',
    });
    await journal.flush();
    const memory = journal.pendingEvidence();
    expect(memory.some((line) => line.includes('music_config_failure'))).toBe(true);
    const pending = await fullLogArchive(dir, {}, [], { journalMemory: memory });
    const pendingTimeline = await readRetainedTimeline(
      JSON.stringify({ schema: 'mizar-support-bundle/1', fullLogs: pending }),
      dir,
    );
    for (const value of [
      'music_config_failure',
      'full original file failure',
      'EACCES',
      'valid.mp3',
      'memory-only',
    ])
      expect(pendingTimeline).toContain(value);
    blocked = false;
    await journal.flush();
    expect(journal.health()).toMatchObject({
      pendingRecords: 0,
      pendingBytes: 0,
      writeError: null,
    });
    const durable = await fullLogArchive(dir, {}, [], { journalMemory: memory });
    const recovered = await readRetainedTimeline(
      JSON.stringify({ schema: 'mizar-support-bundle/1', fullLogs: durable }),
      dir,
    );
    const events = recovered
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { stage?: string; sourceDurability?: string });
    expect(events.filter((event) => event.stage === 'music_config_failure')).toMatchObject([
      { sourceDurability: 'session-log' },
    ]);
  } finally {
    blocked = false;
    await journal.close();
  }
});

it('retains an in-range Host failure in a mixed copied console group after raw Host logs rotate, through real HTTP export and the production reader', async () => {
  const dir = await directory();
  const { NativeSource } = await import('../src/support/native-source.js');
  const fixture = JSON.parse(
    await readFile(
      new URL('../../../scripts/diagnostics/fixtures/capacity-producers.json', import.meta.url),
      'utf8',
    ),
  ) as { consoleEntry: Record<string, unknown> & { detail: string } };
  const consoleDetail = JSON.parse(fixture.consoleEntry.detail) as {
    records: Record<string, unknown>[];
  };
  for (const record of consoleDetail.records) {
    record.sourceAfterUtc = '2026-10-17T09:59:00.000Z';
    record.capturedAt = '2026-10-17T09:59:30.000Z';
  }
  const common = { schemaVersion: 1, startupSessionId: 'mixed-range-host' };
  const entries = [
    {
      ...fixture.consoleEntry,
      ...common,
      time: '2026-10-17T10:02:00.000Z',
      sequence: 1,
      detail: JSON.stringify(consoleDetail),
    },
    {
      ...common,
      time: '2026-10-17T10:00:30.000Z',
      sequence: 2,
      stage: 'workspace_exit',
      result: 'failure',
      detail: JSON.stringify({
        phase: 'presentation',
        cause: 'original mixed Host restore denied',
        os_code: 5,
      }),
    },
  ];
  await writeFile(
    join(dir, 'desktop.ndjson'),
    entries.map((x) => JSON.stringify(x) + '\n').join(''),
  );
  const journal = new SessionJournal(dir);
  const source = new NativeSource(dir, journal);
  await source.poll();
  await source.close();
  await journal.close();
  // Confirm the real producer actually mixed these stages in one group.
  const copied = (await readFile(join(dir, 'session.ndjson'), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { stage: string; evidence?: { entries?: unknown[] } })
    .find((x) => x.stage === 'native_host_records');
  expect(copied?.evidence?.entries).toHaveLength(2);
  await filesystem.unlink(join(dir, 'desktop.ndjson'));
  const app = buildApp({ supportLogsDirectory: dir });
  try {
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const response = await fetch(address + '/debug/support-bundle', {
      method: 'POST',
      headers: { ...request.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ from: '2026-10-17T10:00:00.000Z', to: '2026-10-17T10:01:00.000Z' }),
    });
    expect(response.status).toBe(200);
    const timeline = await readRetainedTimeline(await response.text(), dir);
    expect(timeline).toContain('original mixed Host restore denied');
    expect(timeline).toContain('2026-10-17T10:00:30.000Z');
    expect(timeline).toContain('workspace_exit');
  } finally {
    await app.close();
  }
});
