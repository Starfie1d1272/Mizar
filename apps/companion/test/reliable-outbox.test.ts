import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseReliableEventV1, type ReliableEventV1 } from '@mizar/protocol/output';
import { describe, expect, it } from 'vitest';

import { ReliableOutbox } from '../src/output/reliable-outbox.js';

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
      scoreCT: 13,
      scoreT: 11,
    },
  });
}

describe('bounded reliable output', () => {
  it('dedupes, retries with backoff, and survives a process restart', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mizar-outbox-'));
    try {
      const path = join(dir, 'outbox.json');
      const first = new ReliableOutbox(path);
      const at = new Date('2026-09-28T00:00:00.000Z');
      expect(await first.enqueue(event('event-one'), at)).toBe(true);
      expect(await first.enqueue(event('event-one'), at)).toBe(false);
      let calls = 0;
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
      const recovered = new ReliableOutbox(path);
      await recovered.load();
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
      expect(recovered.getRecords()[0]?.status).toBe('accepted');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('expires old observations and supersedes a stale execution before sending', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mizar-outbox-'));
    try {
      const outbox = new ReliableOutbox(join(dir, 'outbox.json'));
      await outbox.enqueue(event('stale'), new Date('2026-09-28T00:00:00.000Z'));
      await outbox.enqueue(
        event('expired', '2026-09-26T00:00:00.000Z'),
        new Date('2026-09-28T00:00:00.000Z'),
      );
      let sent = 0;
      await outbox.flush({
        now: new Date('2026-09-28T00:00:00.000Z'),
        isCurrent: () => false,
        sink: {
          send: () => {
            sent += 1;
            return Promise.resolve('accepted' as const);
          },
        },
      });
      expect(sent).toBe(0);
      expect(outbox.getRecords().map((record) => record.status)).toEqual(['superseded', 'expired']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
