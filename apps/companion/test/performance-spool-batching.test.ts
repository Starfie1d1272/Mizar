import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { test } from 'node:test';
import { PerformanceSpool, performanceRecordEvent } from '../src/support/performance-spool.js';

test('stores multiple windows in one producer segment and recovers older per-window files', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'mizar-performance-segments-'));
  t.after(() => rm(root, { recursive: true, force: true }));
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
});
