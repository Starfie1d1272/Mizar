import { Buffer } from 'node:buffer';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import { URL } from 'node:url';
import { log } from 'node:console';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setImmediate } from 'node:timers/promises';
import { OutboxRepository } from '../dist/output/outbox-repository.js';
import {
  RELIABLE_OUTBOX_MAX_PENDING,
  RELIABLE_OUTBOX_MAX_RECORDS,
  RELIABLE_OUTBOX_VERSION,
  sealOutbox,
} from '../dist/output/outbox-codec.js';

const fixture = JSON.parse(
  await readFile(
    new URL('../../../packages/protocol/test/fixtures/reliable-event-v1.json', import.meta.url),
    'utf8',
  ),
);
const records = Array.from({ length: RELIABLE_OUTBOX_MAX_RECORDS }, (_, i) => ({
  event: {
    ...fixture,
    idempotencyKey: `bench-${i}`,
    cursor: { ...fixture.cursor, runtimeSeq: i + 1 },
  },
  status: i < RELIABLE_OUTBOX_MAX_PENDING ? 'pending' : 'accepted',
  attempts: 1,
  nextAttemptAt: fixture.observedAt,
  updatedAt: fixture.observedAt,
}));

const iterations = 30;
const simulatedStallMs = 60;
const summarize = (samples) => {
  const ordered = [...samples].sort((a, b) => a - b);
  const p = (fraction) => Number(ordered[Math.ceil(ordered.length * fraction) - 1].toFixed(2));
  return { median: p(0.5), p95: p(0.95), max: p(1) };
};
const dir = await mkdtemp(join(tmpdir(), 'mizar-outbox-bench-'));
const dbPath = join(dir, 'outbox.sqlite');
const legacy = join(dir, 'outbox.json');
const originalExec = DatabaseSync.prototype.exec;
const waitAddress = new Int32Array(new SharedArrayBuffer(4));

let repository;
try {
  repository = await OutboxRepository.open(dbPath, legacy);
  const result = {};
  let active;
  for (const stallMs of [0, simulatedStallMs]) {
    DatabaseSync.prototype.exec = function (sql) {
      if (stallMs && sql === 'COMMIT') Atomics.wait(waitAddress, 0, 0, stallMs);
      return originalExec.call(this, sql);
    };
    const transactionMs = [];
    const loopTurnMs = [];
    for (let i = 0; i < iterations + 3; i++) {
      const start = performance.now();
      const loopTurn = setImmediate().then(() => performance.now() - start);
      active = sealOutbox({
        version: RELIABLE_OUTBOX_VERSION,
        records: records.map((record, index) =>
          index === i ? { ...record, attempts: i + 2 } : record,
        ),
      });
      repository.takeTransactionTiming();
      repository.commit({ active });
      const duration = repository.takeTransactionTiming();
      const delay = await loopTurn;
      if (i >= 3) {
        transactionMs.push(duration.maxMs);
        loopTurnMs.push(delay);
      }
    }
    result[stallMs ? 'simulatedCommitStall' : 'localDisk'] = {
      sqliteMs: summarize(transactionMs),
      nextEventLoopTurnMs: summarize(loopTurnMs),
    };
  }
  DatabaseSync.prototype.exec = originalExec;
  repository.close();
  repository = undefined;
  repository = await OutboxRepository.open(dbPath, legacy);
  assert.deepEqual(repository.active().records, active.records);
  log(
    JSON.stringify(
      {
        node: process.version,
        platform: `${process.platform}-${process.arch}`,
        iterations,
        records: records.length,
        pending: RELIABLE_OUTBOX_MAX_PENDING,
        activeBytes: Buffer.byteLength(JSON.stringify(active)),
        simulatedStallMs,
        recoveredRecords: repository.active().records.length,
        ...result,
      },
      null,
      2,
    ),
  );
} finally {
  DatabaseSync.prototype.exec = originalExec;
  repository?.close();
  await rm(dir, { recursive: true, force: true });
}
