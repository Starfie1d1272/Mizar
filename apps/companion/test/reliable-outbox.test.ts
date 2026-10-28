import * as filesystem from 'node:fs/promises';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseReliableEventV1, type ReliableEventV1 } from '@mizar/protocol/output';
import { describe, expect, it, vi } from 'vitest';

import { ReliableOutbox } from '../src/output/reliable-outbox.js';
import { BusinessJournal } from '../src/support/business-journal.js';
import { readBusinessHistory } from '../src/support/business-history.js';

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
}));

interface DiskOutbox {
  version: string;
  records: { event: ReliableEventV1; status: unknown }[];
  commit?: { id: string; sha256: string };
}

function event(key: string, observedAt = '2026-09-28T00:00:00.000Z'): ReliableEventV1 {
  return parseReliableEventV1({
    schemaVersion: 'mizar.reliable-event.v1',
    idempotencyKey: key,
    kind: 'map_ended',
    cursor: {
      producerInstanceId: 'producer-1',
      liveSessionId: 'session-1',
      runtimeSeq: 10,
      programSourceGeneration: 2,
      programReceiveSequence: 9,
      mapEpoch: 3,
    },
    observedAt,
    matchId: 'match-1',
    competitionId: 'event-1',
    contextRevision: 'revision-1',
    mapId: 'map-1',
    mapName: 'de_ancient',
    entryAId: 'entry-a',
    entryBId: 'entry-b',
    evidence: {
      identity: 'matched',
      telemetryFresh: true,
      contextFresh: true,
      source: 'runtime-transition',
    },
    payload: {
      scoreA: 13,
      scoreB: 11,
      scoreCT: 13,
      scoreT: 11,
    },
  });
}

describe('bounded reliable output', () => {
  it('holds later map events behind a retrying map end', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mizar-map-order-'));
    try {
      const outbox = new ReliableOutbox(join(dir, 'outbox.json'));
      const at = new Date('2026-09-28T00:00:00.000Z');
      const end = event('end');
      const boundary = parseReliableEventV1({
        ...end,
        idempotencyKey: 'next',
        kind: 'map_epoch_changed',
        cursor: { ...end.cursor, mapEpoch: 4, runtimeSeq: 11 },
        payload: { previousMapEpoch: 3, reason: null },
      });
      await outbox.enqueue(end, at);
      await outbox.enqueue(boundary, at);
      const sent: string[] = [];
      await outbox.flush({
        now: at,
        isCurrent: () => true,
        sink: {
          send: (e) => {
            sent.push(e.idempotencyKey);
            return Promise.resolve('retry');
          },
        },
      });
      expect(sent).toEqual(['end']);
      await outbox.flush({
        now: new Date(at.getTime() + 1000),
        isCurrent: () => true,
        sink: {
          send: (e) => {
            sent.push(e.idempotencyKey);
            return Promise.resolve('accepted');
          },
        },
      });
      expect(sent).toEqual(['end', 'end', 'next']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('dedupes, retries with backoff, and survives a process restart', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mizar-outbox-'));
    try {
      const path = join(dir, 'outbox.json');
      vi.stubEnv('MIZAR_APP_VERSION', '1.3.4');
      const journal = new BusinessJournal(dir, () => {});
      const first = new ReliableOutbox(path, undefined, (record, reason) =>
        journal.reliable(record, reason),
      );
      const at = new Date('2026-09-28T00:00:00.000Z');
      expect(await first.enqueue(event('event-one'), at)).toBe(true);
      expect(await first.enqueue(event('event-one'), at)).toBe(false);
      let calls = 0;
      await first.flush({
        now: at,
        isCurrent: () => true,
        canSend: () => false,
        sink: {
          send: () => {
            throw new Error('guard must prevent send');
          },
        },
      });
      expect(first.getRecords()[0]?.attempts).toBe(0);
      await first.flush({
        now: at,
        isCurrent: () => true,
        sink: {
          send: () => {
            calls += 1;
            return Promise.resolve('retry' as const);
          },
        },
      });
      expect(first.getRecords()[0]).toMatchObject({ status: 'pending', attempts: 1 });
      await journal.close();
      vi.stubEnv('MIZAR_APP_VERSION', '1.3.5');
      const restartedJournal = new BusinessJournal(dir, () => {});
      const recovered = new ReliableOutbox(path, undefined, (record, reason) =>
        restartedJournal.reliable(record, reason),
      );
      await recovered.load();
      for (const record of recovered.getRecords()) restartedJournal.reliable(record, 'restored');
      await recovered.flush({
        now: new Date('2026-09-28T00:00:00.500Z'),
        isCurrent: () => true,
        sink: {
          send: () => {
            calls += 1;
            return Promise.resolve('accepted' as const);
          },
        },
      });
      expect(calls).toBe(1);
      await recovered.flush({
        now: new Date('2026-09-28T00:00:01.000Z'),
        isCurrent: () => true,
        sink: {
          send: () => {
            calls += 1;
            return Promise.resolve('accepted' as const);
          },
        },
      });
      expect(calls).toBe(2);
      await restartedJournal.flush();
      const history = readBusinessHistory(dir)
        .groups.flatMap((g) => g.events)
        .filter((entry) => entry.stage === 'business_delivery');
      expect(history.map((entry) => entry.evidence.reason)).toEqual([
        'queued',
        'send_guard_blocked',
        'retry_unknown',
        'restored',
        'receiver_accepted',
      ]);
      expect(history.find((e) => e.evidence.reason === 'restored')?.evidence).toMatchObject({
        generatedVersion: '1.3.4',
        restoredVersion: '1.3.5',
        originalObservedAt: '2026-09-28T00:00:00.000Z',
        sentAt: null,
        acknowledgedAt: null,
      });
      expect(history.at(-1)?.evidence).toMatchObject({
        generatedVersion: '1.3.4',
        status: 'accepted',
        attempts: 2,
        mapEpoch: 3,
        sourceGeneration: 2,
        receiveSequence: 9,
      });
      await recovered.enqueue(event('event-two'), at);
      await recovered.flush({
        now: new Date('2026-09-28T00:00:02.000Z'),
        isCurrent: () => true,
        sink: { send: () => Promise.resolve('rejected' as const) },
      });
      await restartedJournal.flush();
      const rejection = readBusinessHistory(dir)
        .groups.flatMap((g) => g.events)
        .filter((e) => e.stage === 'business_delivery')
        .at(-1)?.evidence;
      expect(rejection).toMatchObject({
        status: 'rejected',
        attempts: 1,
        reason: 'delivery_rejected_unknown',
      });
      expect(recovered.getRecords()[0]?.status).toBe('accepted');
    } finally {
      vi.unstubAllEnvs();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.each(['valid-primary', 'truncated-primary', 'valid-status-corruption'] as const)(
    'does not replay unconfirmed receipts across %s disk snapshots',
    async (scenario) => {
      const dir = await mkdtemp(join(tmpdir(), 'mizar-outbox-generations-'));
      try {
        const path = join(dir, 'outbox.json');
        const seed = new ReliableOutbox(path);
        const at = new Date('2026-09-28T00:00:00Z');
        await seed.enqueue(event('acked'), at);
        const pending = await readFile(path);
        await seed.flush({
          now: at,
          isCurrent: () => true,
          sink: { send: () => Promise.resolve('accepted' as const) },
        });
        await seed.enqueue(event('pending'), at);
        const latest = await readFile(path);
        const primary = JSON.parse(latest.toString('utf8')) as DiskOutbox;
        if (scenario === 'valid-primary') {
          await writeFile(`${path}.last-good`, pending);
        }
        if (scenario === 'truncated-primary') {
          await writeFile(path, latest.subarray(0, 100));
        } else if (scenario !== 'valid-primary') {
          primary.records[0]!.status = 'pending';
          await writeFile(path, JSON.stringify(primary));
        }
        const primaryBefore = await readFile(path);
        const mirrorBefore = await readFile(`${path}.last-good`);
        const box = new ReliableOutbox(path);
        await box.load();
        const send = vi.fn(() => Promise.resolve('accepted' as const));
        await box.flush({ now: at, isCurrent: () => true, canSend: () => true, sink: { send } });
        const verified = scenario === 'valid-primary' || scenario === 'valid-status-corruption';
        expect(send.mock.calls.length).toBe(verified ? 1 : 0);
        if (verified)
          expect(box.getRecords().map((r) => r.event.idempotencyKey)).toEqual(['acked', 'pending']);
        else {
          expect(box.getRecords()).toEqual([]);
          expect(box.getRecovery()?.message).toContain('无法确认完整提交与回执');
        }
        if (scenario !== 'valid-primary') {
          const names = await readdir(dir);
          expect(
            await readFile(
              join(
                dir,
                names.find((n) => n.startsWith('outbox.json.corrupt-'))!,
              ),
            ),
          ).toEqual(primaryBefore);
          expect(
            await readFile(
              join(
                dir,
                names.find((n) => n.startsWith('outbox.json.last-good.corrupt-'))!,
              ),
            ),
          ).toEqual(mirrorBefore);
        }
        const restarted = new ReliableOutbox(path);
        await restarted.load();
        await restarted.flush({ now: at, isCurrent: () => true, sink: { send } });
        expect(send.mock.calls.length).toBe(verified ? 1 : 0);
        if (!verified)
          expect(restarted.getRecovery()?.code).toBe('outbox_preserved_without_records');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );

  it('keeps authoritative memory and disk when interrupted between mirror and primary commits', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mizar-outbox-interrupted-'));
    try {
      const path = join(dir, 'outbox.json');
      const box = new ReliableOutbox(path);
      await box.enqueue(event('committed'));
      const primary = await readFile(path);
      const write = filesystem.writeFile;
      const fault = vi.spyOn(filesystem, 'writeFile').mockImplementation((...args) => {
        if (
          typeof args[0] === 'string' &&
          args[0].includes(`.outbox.json.${process.pid}.`) &&
          args[0].endsWith('.tmp')
        )
          return Promise.reject(
            Object.assign(new Error('disk full at primary write'), { code: 'ENOSPC' }),
          );
        return write(...args);
      });
      try {
        await expect(box.enqueue(event('unpublished'))).rejects.toMatchObject({ code: 'ENOSPC' });
      } finally {
        fault.mockRestore();
      }
      expect(box.getRecords().map((r) => r.event.idempotencyKey)).toEqual(['committed']);
      expect(await readFile(path)).toEqual(primary);
      expect(JSON.parse(await readFile(`${path}.last-good`, 'utf8')) as DiskOutbox).toMatchObject({
        records: [
          { event: { idempotencyKey: 'committed' } },
          { event: { idempotencyKey: 'unpublished' } },
        ],
      });
      const restarted = new ReliableOutbox(path);
      await restarted.load();
      expect(restarted.getRecords().map((r) => r.event.idempotencyKey)).toEqual(['committed']);
      const damaged = JSON.parse(primary.toString('utf8')) as DiskOutbox;
      damaged.records[0]!.status = ['pending'];
      await writeFile(path, JSON.stringify(damaged));
      const quarantined = new ReliableOutbox(path);
      await quarantined.load();
      expect(quarantined.getRecords()).toEqual([]);
      expect(quarantined.getRecovery()?.code).toBe('outbox_preserved_without_records');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
