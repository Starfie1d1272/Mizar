import { mkdtemp, rm, symlink, writeFile, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
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
    expect(readBusinessHistory(dir).manifest.abandonedStagingFiles).toBe(1);
    await expect(stat(join(dir, BUSINESS_HISTORY_FILE + '.tmp'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(await readFile(join(dir, BUSINESS_HISTORY_FILE), 'utf8')).not.toContain(
      'interrupted-uncommitted-CANARY',
    );
    journal.write('business_claim', {
      matchId: 'match-one',
      liveSessionId: 'session-one',
      reason: 'http_403',
    });
    for (let runtimeSeq = 0; runtimeSeq < 150; runtimeSeq++)
      journal.write('business_runtime', {
        matchId: 'match-one',
        liveSessionId: 'session-one',
        reason: 'contiguous',
        runtimeSeq,
        expected: Array.from({ length: 64 }, () => ({
          steam64: '76561199999999999',
          entryId: 'entry-one',
        })),
      });
    const history = readBusinessHistory(dir);
    expect(history.manifest.rotatedEvents).toBeGreaterThan(0);
    expect(
      history.groups
        .find((g) => g.matchId === 'match-one')
        ?.events.some((e) => e.evidence.reason === 'http_403'),
    ).toBe(true);
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
    expect(readBusinessHistory(dir).manifest.rotatedGroups).toBeGreaterThan(0);
    expect(readBusinessHistory(dir).groups.length).toBeLessThanOrEqual(16);
    const blocked = join(dir, 'blocked');
    await writeFile(blocked, 'file');
    const failed = new BusinessJournal(blocked, () => {
      throw new Error('optional logger failure');
    });
    expect(failed.getStatus()).toBe('write_failed');
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
    connection.setBusinessEvidenceHandler((stage, evidence) => journal.write(stage, evidence));
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
    const disk = await readFile(join(dir, BUSINESS_HISTORY_FILE), 'utf8');
    for (const text of [disk, JSON.stringify(readBusinessHistory(dir))]) {
      expect(text).not.toContain(credential);
      expect(text).not.toContain('CANARY-PRIVATE-NAME');
      expect(text).not.toContain('private.example');
    }
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
