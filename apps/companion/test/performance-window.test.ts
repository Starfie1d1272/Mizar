import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { PerformanceWindow, selectedGsiContext } from '../src/support/performance-window.js';
import { SessionJournal } from '../src/support/session-journal.js';

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
