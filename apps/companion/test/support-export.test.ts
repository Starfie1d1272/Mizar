import { mkdtemp, rm, symlink, writeFile, readFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { readSupportLogs } from '../src/support/logs.js';
import { BusinessJournal, BUSINESS_LOG_BYTES } from '../src/support/business-journal.js';
import type { ReliableOutboxRecord } from '../src/output/reliable-outbox.js';
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
  it('exports previous business sessions after restart without leaking private fields', async () => {
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
    const beforeRestart = (await readSupportLogs(dir))
      .find((log) => log.name === 'business.ndjson')!
      .events.filter((event) => event.stage === 'business_runtime');
    expect(beforeRestart.length).toBeLessThan(10);
    expect(
      beforeRestart.some(
        (event) => event.business?.telemetry === 'fresh' && event.business.mapName === 'de_ancient',
      ),
    ).toBe(true);
    await first.close();
    const second = buildApp({ supportLogsDirectory: dir });
    try {
      const response = await second.inject(request);
      expect(response.statusCode).toBe(200);
      const bundle = response.json<{
        snapshot: { businessLog: string };
        logs: { name: string; events: { stage: string; session: string }[] }[];
      }>();
      expect(bundle.snapshot.businessLog).toBe('available');
      const events = bundle.logs.find(
        (log: { name: string }) => log.name === 'business.ndjson',
      )!.events;
      expect(
        new Set(
          events
            .filter((event: { stage: string }) => event.stage === 'business_session')
            .map((event: { session: string }) => event.session),
        ).size,
      ).toBe(2);
      expect(events.filter((event) => event.stage === 'business_runtime').length).toBeGreaterThan(
        2,
      );
      const local = await readFile(join(dir, 'business.ndjson'), 'utf8');
      const session = (JSON.parse(local.split('\n')[0]!) as { startupSessionId: string })
        .startupSessionId;
      expect(response.body).not.toContain(session);
      expect(response.body).not.toContain('PRIVATE-GSI-TOKEN');
      await writeFile(
        join(dir, 'business.ndjson'),
        `${JSON.stringify({ event: 'business', stage: 'business_runtime', error: 'PRIVATE-TOP-LEVEL', err: { message: 'PRIVATE-ERROR' }, evidence: { identity: 'mismatch', issues: ['map_mismatch', 'PRIVATE-NAME'], token: 'PRIVATE-TOKEN', steam64: '76561199999999999', matchRef: 'PRIVATE-MATCH', mapName: 'PRIVATE-SERVER' } })}\n`,
      );
      const sanitized = (await second.inject(request)).body;
      expect(sanitized).toContain('map_mismatch');
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

  it('bounds business history independently of request logs and reports write failure', async () => {
    const dir = await directory();
    const journal = new BusinessJournal(dir, () => {
      throw new Error('optional logger failure');
    });
    // Only the fields used by the diagnostic sink are relevant; no event payload is recorded.
    const event = {
      matchId: 'private-match',
      contextRevision: 'private-revision',
      idempotencyKey: 'private-event',
      kind: 'map_ended',
      mapName: 'de_ancient',
      cursor: {
        producerInstanceId: 'private-producer',
        liveSessionId: 'private-session',
        mapEpoch: 3,
        programSourceGeneration: 2,
        runtimeSeq: 10,
        programReceiveSequence: 9,
      },
    } as ReliableOutboxRecord['event'];
    for (let attempts = 0; attempts < 1000; attempts++)
      journal.reliable(
        { event, status: 'pending', attempts, nextAttemptAt: '', updatedAt: '' },
        'retry_unknown',
      );
    const files = (await readdir(dir)).filter((name) => name.startsWith('business.ndjson'));
    expect(files).toHaveLength(4);
    for (const name of files)
      expect((await stat(join(dir, name))).size).toBeLessThanOrEqual(BUSINESS_LOG_BYTES);
    const logs = await readSupportLogs(dir);
    const business = logs.find((log) => log.name === 'business.ndjson')!;
    expect(business.events.at(-1)?.business).toMatchObject({
      mapEpoch: 3,
      attempts: 999,
      reason: 'retry_unknown',
    });
    expect(JSON.stringify(logs)).not.toContain('private-');
    expect(logs.find((log) => log.name === 'business.ndjson.1')?.truncated).toBe(true);
    const blocked = join(dir, 'blocked');
    await writeFile(blocked, 'file');
    const failed = new BusinessJournal(blocked, () => {
      throw new Error('optional logger failure');
    });
    expect(failed.getStatus()).toBe('write_failed');
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
