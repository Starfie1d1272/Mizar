import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { test } from 'node:test';
import { PerformanceSpool, performanceRecordEvent } from '../src/support/performance-spool.js';
import { DiagnosticDelivery } from '../src/support/delivery.js';
import { SessionJournal } from '../src/support/session-journal.js';

test('stores multiple windows in one producer segment and recovers older per-window files', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'mizar-performance-segments-'));
  const journal = new SessionJournal(root);
  const delivery = new DiagnosticDelivery(root, journal, {
    endpoint: 'https://diagnostics.invalid',
    fetch: async () => {
      throw new Error('delivery is paused');
    },
  });
  t.after(async () => {
    await delivery.close();
    await journal.close();
    await rm(root, { recursive: true, force: true });
  });
  await delivery.initialize(false);
  await delivery.consent(true);
  await delivery.pause(true);
  const directory = join(root, 'performance-pending');
  await mkdir(directory);
  const sessionId = randomUUID();
  const record = (recordSequence: number) => ({
    id: randomUUID(),
    windowId: randomUUID(),
    stage: 'performance_anomaly_begin' as const,
    evidence: { reason: `sample-${recordSequence}` },
    source: {
      time: new Date().toISOString(),
      sessionId,
      hostSessionId: null,
      queuedAfterSequence: 0,
      recordSequence,
      monotonicMs: recordSequence,
    },
  });
  const old = record(1);
  const oldName = `${old.windowId}.0000.gz`;
  await writeFile(
    join(directory, oldName),
    gzipSync(JSON.stringify([performanceRecordEvent(old)])),
  );
  const spool = new PerformanceSpool(root);
  const batch = [record(2), record(3)];
  const committed: string[] = [];
  await spool.append(batch, (ids) => committed.push(...ids));
  assert.deepEqual(
    committed,
    batch.map(({ id }) => id),
  );
  const segment = `${sessionId}.00000000.gz`;
  assert.deepEqual((await readdir(directory)).sort(), [oldName, segment].sort());
  const contents = JSON.parse(gunzipSync(await readFile(join(directory, segment))).toString());
  assert.deepEqual(
    contents.map((event: { windowId: string }) => event.windowId),
    batch.map(({ windowId }) => windowId),
  );
  const reopened = new PerformanceSpool(root);
  await reopened.initialize();
  assert.equal(reopened.health().unreadableFiles, 0);
  await delivery.tick();
  const manifest = JSON.parse(
    await readFile(join(root, 'diagnostic-outbox', 'state.json'), 'utf8'),
  );
  assert.equal(manifest.sessions[`performance:${sessionId}`]?.queued, 3);
  await reopened.append([record(4)], () => {});
  await delivery.tick();
  const next = JSON.parse(await readFile(join(root, 'diagnostic-outbox', 'state.json'), 'utf8'));
  assert.equal(next.sessions[`performance:${sessionId}`]?.queued, 4);
  assert.deepEqual(next.queue.slice(0, manifest.queue.length), manifest.queue);
});
