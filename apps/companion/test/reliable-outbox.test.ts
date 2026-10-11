import * as filesystem from 'node:fs/promises';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseReliableEventV1, type ReliableEventV1 } from '@mizar/protocol/output';
import { describe, expect, it, vi } from 'vitest';

import { ReliableOutbox } from '../src/output/reliable-outbox.js';

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
}));

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
  it('preserves malformed bytes and reports missing records instead of blocking startup', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mizar-outbox-corrupt-'));
    try {
      for (const [index, bytes] of [Buffer.alloc(32), Buffer.from('{"version":')].entries()) {
        const path = join(dir, `broken-${index}.json`);
        await writeFile(path, bytes);
        let originalError: unknown;
        const outbox = new ReliableOutbox(path, (_report, error) => {
          originalError = error;
        });
        await outbox.load();
        expect(originalError).toBeInstanceOf(SyntaxError);
        expect(outbox.getRecovery()).toMatchObject({
          code: 'outbox_preserved_without_records',
          recoveredRecords: 0,
        });
        const preserved = (await readdir(dir)).find((name) =>
          name.startsWith(`broken-${index}.json.corrupt-`),
        )!;
        expect(await readFile(join(dir, preserved))).toEqual(bytes);
        await outbox.enqueue(event(`new-${index}`));
        const restarted = new ReliableOutbox(path);
        await restarted.load();
        expect(restarted.getRecords()[0]?.event.idempotencyKey).toBe(`new-${index}`);
        expect(restarted.getRecovery()).toBeUndefined();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('salvages only strict records, drops invalid continuity, and keeps delivery gates', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mizar-outbox-partial-'));
    try {
      const path = join(dir, 'outbox.json');
      const seed = new ReliableOutbox(path);
      await seed.enqueue(event('kept'));
      const value = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
      await seed.enqueue(event('mirror-only'));
      const mirrorOriginal = await readFile(`${path}.last-good`);
      const firstRecord = seed.getRecords()[0]!;
      value.records = [
        firstRecord,
        { ...firstRecord, event: { ...firstRecord.event, schemaVersion: 'unsupported' } },
        { ...firstRecord, status: ['pending'] },
        { ...firstRecord, status: ['accepted'] },
      ];
      value.continuity = { secret: 'must-not-escape' };
      const original = Buffer.from(JSON.stringify(value));
      await writeFile(path, original);
      const recovered = new ReliableOutbox(path);
      await recovered.load();
      expect(recovered.getRecords().map((record) => record.event.idempotencyKey)).toEqual(['kept']);
      expect(recovered.getContinuity()).toBeUndefined();
      const mirrorArchive = (await readdir(dir)).find((name) =>
        name.startsWith('outbox.json.last-good.corrupt-'),
      )!;
      expect(await readFile(join(dir, mirrorArchive))).toEqual(mirrorOriginal);
      expect(recovered.getRecovery()).toMatchObject({
        code: 'outbox_recovered',
        recoveredRecords: 1,
      });
      const preserved = (await readdir(dir)).find((name) =>
        name.startsWith('outbox.json.corrupt-'),
      )!;
      expect(await readFile(join(dir, preserved))).toEqual(original);
      let sent = false;
      await recovered.flush({
        now: new Date('2026-09-28T00:00:01Z'),
        isCurrent: () => true,
        canSend: () => false,
        sink: {
          send: () => {
            sent = true;
            return Promise.resolve('accepted' as const);
          },
        },
      });
      expect(sent).toBe(false);
      expect(recovered.getRecords()[0]?.status).toBe('pending');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('restores a validated mirror without rewriting event identity, and preserves bad mirrors', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mizar-outbox-mirror-'));
    try {
      const path = join(dir, 'outbox.json');
      const seed = new ReliableOutbox(path);
      await seed.enqueue(event('original-key'));
      const prior = seed.getRecords();
      const continuity = seed.getContinuity();
      await writeFile(path, Buffer.alloc(24));
      const recovered = new ReliableOutbox(path);
      await recovered.load();
      expect(recovered.getRecords()).toEqual(prior);
      expect(recovered.getContinuity()).toEqual(continuity);
      await rm(path);
      const missing = new ReliableOutbox(path);
      await missing.load();
      expect(missing.getRecords()).toEqual(prior);
      await writeFile(path, Buffer.alloc(5));
      await writeFile(`${path}.last-good`, Buffer.from('{'));
      const broken = new ReliableOutbox(path);
      await broken.load();
      expect(broken.getRecovery()?.recoveredRecords).toBe(0);
      const archives = (await readdir(dir)).filter((name) =>
        name.startsWith('outbox.json.last-good.corrupt-'),
      );
      expect(
        await Promise.all(archives.map((name) => readFile(join(dir, name), 'utf8'))),
      ).toContain('{');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('does not swallow I/O failure or publish an unsuccessful durable commit', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mizar-outbox-io-'));
    try {
      const unreadable = new ReliableOutbox(dir);
      await expect(unreadable.load()).rejects.toBeDefined();
      expect(unreadable.getRecovery()).toBeUndefined();
      const path = join(dir, 'outbox.json');
      await mkdir(`${path}.last-good`);
      const outbox = new ReliableOutbox(path);
      await expect(outbox.enqueue(event('not-committed'))).rejects.toBeDefined();
      expect(outbox.getRecords()).toEqual([]);
      await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
      await rm(`${path}.last-good`, { recursive: true });
      await writeFile(path, Buffer.alloc(10));
      const denyArchive = vi
        .spyOn(filesystem, 'writeFile')
        .mockRejectedValueOnce(
          Object.assign(new Error('archive permission denied'), { code: 'EACCES' }),
        );
      try {
        const failure: unknown = await outbox.load().catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(Error);
        if (!(failure instanceof Error)) throw new Error('expected recovery failure');
        expect(failure.message).toContain('另存原始文件失败');
        expect(failure.cause).toMatchObject({ code: 'EACCES' });
      } finally {
        denyArchive.mockRestore();
      }
      expect(await readFile(path)).toEqual(Buffer.alloc(10));
      expect(outbox.getRecovery()).toBeUndefined();
      await mkdir(`${path}.last-good`);
      await writeFile(path, Buffer.alloc(10));
      await expect(outbox.load()).rejects.toBeDefined();
      expect(await readFile(path)).toEqual(Buffer.alloc(10));
      expect(outbox.getRecovery()).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
