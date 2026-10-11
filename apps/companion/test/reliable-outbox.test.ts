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
        expect(restarted.getRecovery()?.code).toBe('outbox_preserved_without_records');
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('recovers both committed end events when only the second primary status is damaged', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mizar-outbox-two-ends-'));
    try {
      const path = join(dir, 'outbox.json');
      const seed = new ReliableOutbox(path);
      const at = new Date('2026-09-28T00:00:00Z');
      const first = event('first');
      const second = parseReliableEventV1({
        ...event('second'),
        kind: 'series_ended',
        payload: { scoreA: 2, scoreB: 1 },
      });
      await seed.enqueue(first, at);
      await seed.enqueue(second, at);
      const committed = await readFile(path);
      expect(await readFile(`${path}.last-good`)).toEqual(committed);
      const damaged = JSON.parse(committed.toString('utf8')) as DiskOutbox;
      damaged.records[1]!.status = ['pending'];
      await writeFile(path, JSON.stringify(damaged));
      const recovered = new ReliableOutbox(path);
      await recovered.load();
      expect(recovered.getRecords().map((record) => record.event)).toEqual([first, second]);
      const sent: ReliableEventV1[] = [];
      await recovered.flush({
        now: at,
        isCurrent: () => true,
        canSend: () => true,
        sink: {
          send: (event) => {
            sent.push(event);
            return Promise.resolve('accepted' as const);
          },
        },
      });
      expect(sent).toEqual([first, second]);
      expect(recovered.getRecovery()?.recoveredRecords).toBe(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('isolates partial primary and another commit instead of mixing or reporting completion', async () => {
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
      expect(recovered.getRecords()).toEqual([]);
      expect(recovered.getContinuity()).toBeUndefined();
      const mirrorArchive = (await readdir(dir)).find((name) =>
        name.startsWith('outbox.json.last-good.corrupt-'),
      )!;
      expect(await readFile(join(dir, mirrorArchive))).toEqual(mirrorOriginal);
      expect(recovered.getRecovery()).toMatchObject({
        code: 'outbox_preserved_without_records',
        recoveredRecords: 0,
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
      expect(recovered.getRecovery()?.message).toContain('旧事件暂停发送');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('isolates unreadable or missing primary even with a valid mirror, and preserves bad mirrors', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mizar-outbox-mirror-'));
    try {
      const path = join(dir, 'outbox.json');
      const seed = new ReliableOutbox(path);
      await seed.enqueue(event('original-key'));

      await writeFile(path, Buffer.alloc(24));
      const recovered = new ReliableOutbox(path);
      await recovered.load();
      expect(recovered.getRecords()).toEqual([]);
      expect(recovered.getContinuity()).toBeUndefined();
      await rm(path);
      const missing = new ReliableOutbox(path);
      await missing.load();
      expect(missing.getRecords()).toEqual([]);
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

  it.each([
    'older-mirror',
    'newer-mirror',
    'valid-primary',
    'legacy-partial',
    'truncated-primary',
    'damaged-mirror',
    'metadata-damaged',
    'valid-status-corruption',
  ] as const)('does not replay unconfirmed receipts across %s disk snapshots', async (scenario) => {
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
      if (scenario === 'older-mirror' || scenario === 'valid-primary') {
        await writeFile(`${path}.last-good`, pending);
      } else if (scenario === 'newer-mirror') {
        // Power loss after mirror rename and before primary rename: unpublished enqueue.
        await writeFile(path, pending);
      } else if (scenario === 'legacy-partial') {
        primary.version = 'mizar.reliable-outbox.v1';
        delete primary.commit;
      } else if (scenario === 'damaged-mirror') {
        await writeFile(`${path}.last-good`, Buffer.from('{'));
      } else if (scenario === 'metadata-damaged') {
        primary.commit!.sha256 = '0'.repeat(64);
      }
      if (scenario === 'truncated-primary') {
        await writeFile(path, latest.subarray(0, 100));
      } else if (scenario !== 'valid-primary') {
        const damaged =
          scenario === 'newer-mirror'
            ? (JSON.parse(pending.toString('utf8')) as DiskOutbox)
            : primary;
        damaged.records[0]!.status =
          scenario === 'valid-status-corruption' ? 'pending' : ['pending'];
        await writeFile(path, JSON.stringify(damaged));
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
      if (!verified) expect(restarted.getRecovery()?.code).toBe('outbox_preserved_without_records');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('preserves accepted receipts and original identities in a verified mirror and retains authorization/backoff gates', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mizar-outbox-verified-ack-'));
    try {
      const path = join(dir, 'outbox.json');
      const seed = new ReliableOutbox(path);
      const at = new Date('2026-09-28T00:00:00Z');
      await seed.enqueue(event('acked'), at);
      await seed.flush({
        now: at,
        isCurrent: () => true,
        sink: { send: () => Promise.resolve('accepted' as const) },
      });
      await seed.enqueue(event('pending'), at);
      await seed.flush({
        now: at,
        isCurrent: () => true,
        sink: { send: () => Promise.resolve('retry' as const) },
      });
      const expected = seed.getRecords();
      const damaged = JSON.parse(await readFile(path, 'utf8')) as DiskOutbox;
      damaged.records[1]!.status = ['pending'];
      await writeFile(path, JSON.stringify(damaged));
      const recovered = new ReliableOutbox(path);
      await recovered.load();
      expect(recovered.getRecords()).toEqual(expected);
      expect(recovered.getContinuity()).toEqual(seed.getContinuity());
      expect(await recovered.enqueue(event('pending'), at)).toBe(false);
      const send = vi.fn(() => Promise.resolve('accepted' as const));
      await recovered.flush({ now: at, isCurrent: () => true, sink: { send } });
      await recovered.flush({
        now: new Date(at.getTime() + 1000),
        isCurrent: () => true,
        canSend: () => false,
        sink: { send },
      });
      expect(send).not.toHaveBeenCalled();
      await recovered.flush({
        now: new Date(at.getTime() + 1000),
        isCurrent: () => true,
        canSend: () => true,
        sink: { send },
      });
      expect(send).toHaveBeenCalledExactlyOnceWith(event('pending'), expect.any(AbortSignal));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('loads intact v1 queues and migrates on the next durable commit', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mizar-outbox-v1-'));
    try {
      const path = join(dir, 'outbox.json');
      const at = '2026-09-28T00:00:00.000Z';
      const record = {
        event: event('legacy'),
        status: 'accepted',
        attempts: 1,
        nextAttemptAt: at,
        updatedAt: at,
      };
      await writeFile(
        path,
        JSON.stringify({ version: 'mizar.reliable-outbox.v1', records: [record] }),
      );
      const box = new ReliableOutbox(path);
      await box.load();
      expect(box.getRecords()).toEqual([record]);
      await box.enqueue(event('new'), new Date(at));
      const saved = JSON.parse(await readFile(path, 'utf8')) as DiskOutbox;
      expect(saved.version).toBe('mizar.reliable-outbox.v2');
      expect(saved.commit!.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(await readFile(`${path}.last-good`)).toEqual(await readFile(path));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

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

  it('reports recovery commit I/O failure with its stage and retries without publishing partial memory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mizar-outbox-recovery-io-'));
    try {
      const path = join(dir, 'outbox.json');
      const seed = new ReliableOutbox(path);
      await seed.enqueue(event('pending'));
      const damaged = JSON.parse(await readFile(path, 'utf8')) as DiskOutbox;
      damaged.records[0]!.status = ['pending'];
      const bytes = Buffer.from(JSON.stringify(damaged));
      await writeFile(path, bytes);
      const evidence: unknown[] = [];
      const box = new ReliableOutbox(path, (report, error) => evidence.push({ report, error }));
      const write = filesystem.writeFile;
      const fault = vi.spyOn(filesystem, 'writeFile').mockImplementation((...args) => {
        if (
          typeof args[0] === 'string' &&
          args[0].includes(`.outbox.json.${process.pid}.`) &&
          args[0].endsWith('.tmp')
        )
          return Promise.reject(Object.assign(new Error('disk full'), { code: 'ENOSPC' }));
        return write(...args);
      });
      try {
        const failure: unknown = await box.load().catch((error: unknown) => error);
        expect(failure).toMatchObject({
          code: 'outbox_recovery_failed',
          cause: { code: 'ENOSPC' },
        });
        if (!(failure instanceof Error)) throw new Error('expected recovery error');
        expect(failure.message).toContain('保存恢复队列失败');
      } finally {
        fault.mockRestore();
      }
      expect(evidence[0]).toMatchObject({
        report: undefined,
        error: { message: 'outbox_recovery_failed' },
      });
      expect(box.getRecords()).toEqual([]);
      expect(box.getRecovery()).toBeUndefined();
      expect(await readFile(path)).toEqual(bytes);
      const names = await readdir(dir);
      expect(
        await readFile(
          join(
            dir,
            names.find((n) => n.startsWith('outbox.json.corrupt-'))!,
          ),
        ),
      ).toEqual(bytes);
      await box.load();
      expect(box.getRecords().map((r) => r.event.idempotencyKey)).toEqual(['pending']);
      expect(box.getRecovery()?.code).toBe('outbox_recovered');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('does not swallow I/O failure or publish an unsuccessful durable commit', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mizar-outbox-io-'));
    try {
      const unreadable = new ReliableOutbox(dir);
      await expect(unreadable.load()).rejects.toMatchObject({
        code: 'outbox_recovery_failed',
        message: '发送队列读取主文件失败。检查数据目录权限与磁盘空间后重试；保留原队列，不要删除。',
        cause: { code: 'EISDIR' },
      });
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
