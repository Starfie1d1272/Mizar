import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it, vi } from 'vitest';
import { PerformanceSpool } from '../src/support/performance-spool.js';
vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof import('node:fs/promises')>()),
}));
import * as filesystem from 'node:fs/promises';
import { PerformanceWindow, selectedGsiContext } from '../src/support/performance-window.js';
import { SessionJournal } from '../src/support/session-journal.js';

it('isolates unreadable pending packets, exports the missing scope and recovers after the file is repaired', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mizar-performance-source-'));
  const sessionId = randomUUID();
  const values = [0, 1].map(() => ({
    id: randomUUID(),
    windowId: randomUUID(),
    stage: 'performance_anomaly_trigger' as const,
    source: {
      time: new Date().toISOString(),
      sessionId,
      hostSessionId: null,
      queuedAfterSequence: 0,
      recordSequence: 1,
      monotonicMs: 0,
    },
    evidence: { reason: 'public-test' },
  }));
  try {
    const original = new PerformanceSpool(directory);
    await original.append(values, () => {});
    const badName = `${values[0]!.windowId}.0000.json`;
    const path = join(directory, 'performance-pending', badName);
    const valid = await readFile(path);
    await writeFile(path, '{incomplete');
    const recovered = new PerformanceSpool(directory);
    const healthy = await recovered.oldest();
    expect(healthy?.records[0]?.id).toBe(values[1]!.id);
    expect(recovered.health().unreadableFiles).toBe(1);
    await recovered.acknowledge(
      healthy!.name,
      healthy!.records.map((value) => value.id),
    );
    const exported = [];
    for await (const value of recovered.export()) exported.push(value);
    expect(exported).toHaveLength(1);
    expect(exported[0]).toMatchObject({
      status: 'unreadable',
      name: `performance-pending/${badName}`,
    });
    await writeFile(path, valid);
    await vi.waitFor(
      async () => {
        expect((await recovered.oldest())?.records[0]?.id).toBe(values[0]!.id);
      },
      { timeout: 2000 },
    );
    expect(recovered.health().unreadableFiles).toBe(0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('persists pre/post source evidence in bounded chunks and marks interrupted/oversized coverage', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mizar-performance-'));
  const journal = new SessionJournal(directory);
  let now = 0;
  const context = new PerformanceWindow(journal, () => now);
  try {
    for (now = 0; now < 40000; now += 250)
      context.sample({
        sequence: now / 250,
        time: new Date(now).toISOString(),
        monotonicMs: now,
        evidence: selectedGsiContext({
          auth: { token: 'never-collect-this' },
          allplayers: {
            'public-id': { name: 'private-name', position: '1,2,3', state: { health: 87 } },
          },
        }),
      });
    context.trigger('test_error', { sequence: 160 });
    for (now = 40000; now <= 42000; now += 250)
      context.sample({ sequence: now / 250, time: '', monotonicMs: now, evidence: { health: 12 } });
    context.sample({ sequence: 999, time: '', monotonicMs: 43000, evidence: 'x'.repeat(13000) });
    await context.close();
    await journal.close();
    const text = (
      await Promise.all(
        (await readdir(directory))
          .filter((name) => name.endsWith('.ndjson'))
          .map((name) => readFile(join(directory, name), 'utf8')),
      )
    ).join('\n');
    const records = text
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(
        (line) =>
          JSON.parse(line) as {
            stage: string;
            evidence: { phase?: string; samples: { sequence: number }[]; [key: string]: unknown };
          },
      );
    const chunks = records.filter((value) => value.stage === 'performance_anomaly_samples');
    const before = chunks
      .filter((value) => value.evidence.phase === 'before')
      .flatMap((value) => value.evidence.samples);
    const after = chunks
      .filter((value) => value.evidence.phase === 'after')
      .flatMap((value) => value.evidence.samples);
    expect(before[0]?.sequence).toBe(40);
    expect(before.at(-1)?.sequence).toBe(159);
    expect(after.map((sample) => sample.sequence)).toEqual([
      160, 161, 162, 163, 164, 165, 166, 167, 168,
    ]);
    expect(
      records.find((value) => value.stage === 'performance_anomaly_end')?.evidence,
    ).toMatchObject({
      reason: 'shutdown',
      postIncomplete: true,
      coverageAfter: { oversizedSamples: 1 },
    });
    expect(text).not.toContain('never-collect-this');
    expect(text).not.toContain('private-name');
    expect(context.health().ringBytes).toBeLessThanOrEqual(1024 * 1024);
    expect(context.health().pendingBytes).toBe(0);
  } finally {
    await context.close();
    await journal.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it('keeps full redacted window evidence on disk and automatically retries a recoverable journal write failure', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mizar-performance-retry-'));
  const journal = new SessionJournal(directory);
  let blocked = true;
  const originalOpen = filesystem.open;
  vi.spyOn(filesystem, 'open').mockImplementation(async (...args) => {
    const handle = await originalOpen(...args);
    if (String(args[0]) === join(directory, 'session.ndjson')) {
      const write = handle.writeFile.bind(handle);
      vi.spyOn(handle, 'writeFile').mockImplementation(async (data, options) => {
        if (blocked && typeof data === 'string' && data.includes('performance_anomaly_'))
          throw Object.assign(new Error('synthetic journal write busy'), { code: 'EBUSY' });
        await write(data, options);
      });
    }
    return handle;
  });
  let now = 0;
  const context = new PerformanceWindow(journal, () => now, directory);
  let release: (() => Promise<void>) | undefined;
  try {
    context.sample({
      sequence: 10,
      time: new Date().toISOString(),
      monotonicMs: now,
      evidence: { health: 100 },
    });
    context.trigger('public-io-failure', {
      error: new Error('outer token=PRIVATE-RETRY', { cause: new Error('original draw cause') }),
    });
    now = 250;
    context.sample({
      sequence: 11,
      time: new Date().toISOString(),
      monotonicMs: now,
      evidence: { health: 17 },
    });
    await context.flush();
    expect(context.health()).toMatchObject({ pendingRecords: 0, spool: { pendingFiles: 1 } });
    const stored: string[] = [];
    for await (const file of new PerformanceSpool(directory).export())
      stored.push(file.bytes.toString('utf8'));
    expect(stored.join('')).toContain('original draw cause');
    expect(stored.join('')).not.toContain('PRIVATE-RETRY');
    const name = (await readdir(join(directory, 'performance-pending'))).find((name) =>
      name.endsWith('.json'),
    )!;
    const frozen = await readFile(join(directory, 'performance-pending', name));
    release = await context.beginExport();
    blocked = false;
    // No export/flush is used to resume: the background retry must recover it.
    await vi.waitFor(() => expect(context.health().spool?.pendingFiles).toBe(0), {
      timeout: 2500,
      interval: 20,
    });
    expect(context.health().spool).toMatchObject({ files: 1, exportPinnedFiles: 1 });
    context.trigger('public-anomaly-during-export');
    await context.flush();
    expect(await readFile(join(directory, 'performance-pending', name))).toEqual(frozen);
    await release();
    release = undefined;
    expect(context.health().spool?.files).toBe(0);
    await context.close();
    await journal.close();
    const disk = await readFile(join(directory, 'session.ndjson'), 'utf8');
    expect(disk).toContain('original draw cause');
    expect(disk).toContain('"health":100');
    expect(disk).toContain('"health":17');
    expect(disk).not.toContain('PRIVATE-RETRY');
    expect(context.health().writeFailures).toBeGreaterThan(0);
  } finally {
    blocked = false;
    await release?.();
    await context.close();
    await journal.close();
    vi.restoreAllMocks();
    await rm(directory, { recursive: true, force: true });
  }
});

it('keeps a memory-only export snapshot when the spool recovers during package assembly', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mizar-performance-export-race-'));
  const journal = new SessionJournal(directory);
  let blocked = true;
  const originalOpen = filesystem.open;
  vi.spyOn(filesystem, 'open').mockImplementation(async (...args) => {
    if (blocked && String(args[0]).includes('performance-pending'))
      throw Object.assign(new Error('synthetic spool EACCES'), { code: 'EACCES' });
    return originalOpen(...args);
  });
  const context = new PerformanceWindow(journal, () => 0, directory);
  let release: (() => Promise<void>) | undefined;
  try {
    context.trigger('memory-only-original-cause');
    await context.flush();
    expect(context.health().pendingRecords).toBeGreaterThan(0);
    release = await context.beginExport();
    const snapshot = context.exportMemory();
    expect(JSON.stringify(snapshot)).toContain('memory-only-original-cause');
    blocked = false;
    await vi.waitFor(() => expect(context.health().pendingRecords).toBe(0), { timeout: 2500 });
    expect(context.exportMemory()).toEqual(snapshot);
    await release();
    release = undefined;
    expect(context.exportMemory()).toEqual([]);
  } finally {
    blocked = false;
    await release?.();
    await context.close();
    await journal.close();
    vi.restoreAllMocks();
    await rm(directory, { recursive: true, force: true });
  }
});

it('bounds flood memory, reports omitted context and rate-limits oversized sampling attempts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mizar-performance-flood-'));
  const journal = new SessionJournal(directory);
  let now = 0;
  const context = new PerformanceWindow(journal, () => now);
  try {
    for (; now < 30000; now += 250)
      context.sample({ sequence: now, time: '', monotonicMs: now, evidence: 'x'.repeat(11000) });
    expect(context.health().ringBytes).toBeLessThanOrEqual(1024 * 1024);
    expect(context.health().coverage.ringBudgetEvictions).toBeGreaterThan(0);
    for (let i = 0; i < 100; i++)
      context.sample({ sequence: i, time: '', monotonicMs: now + i, evidence: 'x'.repeat(13000) });
    expect(context.health().coverage.oversizedSamples).toBe(1);
    for (let i = 0; i < 18000; i++) context.trigger('public-flood', { sequence: i });
    expect(context.health().pendingBytes).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(context.health().coverage.omittedRecords).toBeGreaterThan(0);
    await context.close();
    await journal.close();
    const text = await readFile(join(directory, 'session.ndjson'), 'utf8');
    expect(text).toContain('performance_context_health');
    expect(context.health().pendingBytes).toBe(0);
  } finally {
    await context.close();
    await journal.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it('retains ordinary journal records after partial IO and retries without leaving a malformed prefix', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mizar-journal-retry-'));
  const journal = new SessionJournal(directory);
  let blocked = true;
  const originalOpen = filesystem.open;
  vi.spyOn(filesystem, 'open').mockImplementation(async (...args) => {
    const handle = await originalOpen(...args);
    if (String(args[0]) === join(directory, 'session.ndjson')) {
      const write = handle.writeFile.bind(handle);
      vi.spyOn(handle, 'writeFile').mockImplementation(async (data, options) => {
        if (blocked && typeof data === 'string' && data.includes('ordinary-operation')) {
          await write(data.slice(0, Math.floor(data.length / 2)), options);
          throw Object.assign(new Error('synthetic partial write'), { code: 'EIO' });
        }
        await write(data, options);
      });
    }
    return handle;
  });
  try {
    journal.record('operation_result', {
      operation: 'ordinary-operation',
      result: 'confirmed',
      password: 'PRIVATE-JOURNAL',
    });
    await journal.flush();
    expect(journal.health().pendingRecords).toBeGreaterThan(0);
    expect(journal.health().writeError).toMatchObject({ code: 'EIO' });
    blocked = false;
    await vi.waitFor(() => expect(journal.health().pendingRecords).toBe(0), {
      timeout: 2500,
      interval: 20,
    });
    await journal.close();
    const disk = await readFile(join(directory, 'session.ndjson'), 'utf8');
    const records = disk
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { stage: string; evidence: unknown });
    expect(records.filter((record) => record.stage === 'operation_result')).toEqual([
      expect.objectContaining({
        evidence: { operation: 'ordinary-operation', result: 'confirmed', password: '[redacted]' },
      }),
    ]);
    expect(disk).not.toContain('PRIVATE-JOURNAL');
  } finally {
    blocked = false;
    await journal.close();
    vi.restoreAllMocks();
    await rm(directory, { recursive: true, force: true });
  }
});
