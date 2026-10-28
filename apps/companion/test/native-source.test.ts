import { appendFile, link, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { NativeSource } from '../src/support/native-source.js';
import { SessionJournal } from '../src/support/session-journal.js';
vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof import('node:fs/promises')>()),
}));
import * as filesystem from 'node:fs/promises';
const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'mizar-native-source-'));
  directories.push(directory);
  const journal = new SessionJournal(directory, { hostStartupSessionId: 'old-borrowed-host' });
  const source = new NativeSource(directory, journal);
  return { directory, journal, source, path: join(directory, 'desktop.ndjson') };
}
function event(stage: string, host = 'host-A') {
  return {
    schemaVersion: 1,
    startupSessionId: host,
    time: new Date().toISOString(),
    stage,
    result: 'success',
    taskId: '11111111-1111-4111-8111-111111111111',
    operationId: '22222222-2222-4222-8222-222222222222',
    trigger: 'user',
    detail: JSON.stringify({
      args: '-applaunch 730 -worldwide',
      phase: '游戏收尾',
      token: 'PRIVATE-CREDENTIAL',
    }),
  };
}
async function entries(directory: string) {
  const text = await readFile(join(directory, 'session.ndjson'), 'utf8');
  const records = text
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(
      (line) =>
        JSON.parse(line) as {
          stage: string;
          taskId: string | null;
          trigger: string;
          evidence: {
            entries?: { sourceRecordId: string; entry: ReturnType<typeof event> }[];
            [key: string]: unknown;
          };
        },
    );
  return { text, records, entries: records.flatMap((record) => record.evidence.entries ?? []) };
}

it('copies original Host identity, task and parameters across partial UTF-8, rotations and Companion restart', async () => {
  const { directory, journal, source, path } = await setup();
  const first = Buffer.from(JSON.stringify(event('cs2_launch_arguments')) + '\n');
  const split = first.indexOf(Buffer.from('游戏')) + 1;
  await writeFile(path, first.subarray(0, split));
  try {
    await source.poll();
    expect(source.health().copied).toBe(0);
    expect(source.health().backlogBytes).toBe(split);
    await appendFile(path, first.subarray(split));
    await journal.withRequest(
      {
        requestId: 'export-request',
        browserOperationId: null,
        taskId: '33333333-3333-4333-8333-333333333333',
        trigger: 'user',
      },
      () => source.poll(),
    );
    expect(source.health().copied).toBe(1);
    await rename(path, join(directory, 'desktop.1.ndjson'));
    await writeFile(path, JSON.stringify(event('workspace_exit_wait', 'host-B')) + '\n');
    await source.poll();
    await source.close();
    await journal.close();
    const nextJournal = new SessionJournal(directory, {
      hostStartupSessionId: 'old-borrowed-host',
    });
    const next = new NativeSource(directory, nextJournal);
    try {
      await next.poll();
      expect(next.health().copied).toBe(0);
      await appendFile(path, JSON.stringify(event('workspace_exit_terminal', 'host-B')) + '\n');
      await next.poll();
      await next.close();
      await nextJournal.close();
      const restored = await entries(directory);
      expect(restored.entries.map((record) => record.entry.stage)).toEqual([
        'cs2_launch_arguments',
        'workspace_exit_wait',
        'workspace_exit_terminal',
      ]);
      expect(restored.entries.map((record) => record.entry.startupSessionId)).toEqual([
        'host-A',
        'host-B',
        'host-B',
      ]);
      expect(restored.entries[0]?.entry).toMatchObject({
        taskId: event('').taskId,
        trigger: 'user',
      });
      expect(
        restored.records.find((record) => record.stage === 'native_host_records'),
      ).toMatchObject({
        taskId: null,
        trigger: 'system',
      });
      expect(restored.text).toContain('-applaunch 730 -worldwide');
      expect(restored.text).not.toContain('PRIVATE-CREDENTIAL');
      expect(new Set(restored.entries.map((record) => record.sourceRecordId)).size).toBe(3);
    } finally {
      await next.close();
      await nextJournal.close();
    }
  } finally {
    await source.close();
    await journal.close();
  }
});

it('does not advance the source cursor when durable journal commit fails', async () => {
  const { directory, journal, source, path } = await setup();
  await writeFile(path, JSON.stringify(event('workspace_exit_begin')) + '\n');
  const commit = vi
    .spyOn(journal, 'recordCommitted')
    .mockRejectedValueOnce(new Error('disk fsync denied'));
  try {
    await source.poll();
    expect(source.health()).toMatchObject({ failures: 1, copied: 0, invalidRecords: 0 });
    expect(
      await readFile(join(directory, 'native-source-cursor.json'), 'utf8').catch(() => null),
    ).toBeNull();
    await source.poll();
    await journal.flush();
    expect(source.health()).toMatchObject({ error: null, copied: 1, invalidRecords: 0 });
    expect((await entries(directory)).entries).toHaveLength(1);
    expect(commit).toHaveBeenCalledTimes(2);
  } finally {
    await source.close();
    await journal.close();
  }
});

it('advances in memory and retries the checkpoint after cursor persistence fails', async () => {
  const { directory, journal, source, path } = await setup();
  await writeFile(path, JSON.stringify(event('workspace_exit_terminal')) + '\n');
  const originalRename = filesystem.rename;
  let fail = true;
  vi.spyOn(filesystem, 'rename').mockImplementation(async (from, to) => {
    if (String(to).endsWith('native-source-cursor.json') && fail) {
      throw new Error('cursor rename denied');
    }
    await originalRename(from, to);
  });
  try {
    await source.poll();
    expect(source.health().failures).toBe(1);
    await appendFile(path, JSON.stringify(event('new_record')) + '\n');
    await source.poll();
    await journal.flush();
    const restored = await entries(directory);
    expect(restored.entries).toHaveLength(2);
    expect(restored.entries.map((record) => record.entry.stage)).toEqual([
      'workspace_exit_terminal',
      'new_record',
    ]);
    expect(source.health().error).toBe('native_source_unavailable');
    fail = false;
    await source.poll();
    expect(source.health().error).toBeNull();
    await journal.flush();
    const stages = (await entries(directory)).records.map((record) => record.stage);
    expect(stages.filter((stage) => stage === 'native_source_failure')).toHaveLength(1);
    expect(stages).toContain('native_source_recovered');
    const checkpoint = JSON.parse(
      await readFile(join(directory, 'native-source-cursor.json'), 'utf8'),
    ) as { cursors: { offset: number }[] };
    expect(checkpoint.cursors[0]?.offset).toBe((await filesystem.stat(path)).size);
  } finally {
    await source.close();
    await journal.close();
  }
});

it('marks rewritten and malformed data while continuing with the next valid source record', async () => {
  const { directory, journal, source, path } = await setup();
  await writeFile(path, JSON.stringify(event('before_rewrite')) + '\n');
  try {
    await source.poll();
    await writeFile(path, '{broken json}\n' + JSON.stringify(event('after_rewrite')) + '\n');
    await source.poll();
    await journal.flush();
    const restored = await entries(directory);
    expect(restored.entries.map((record) => record.entry.stage)).toEqual([
      'before_rewrite',
      'after_rewrite',
    ]);
    expect(
      restored.records
        .filter((record) => record.stage === 'native_source_gap')
        .map((record) => record.evidence.reason),
    ).toEqual(['source_truncated_or_rewritten', 'invalid_or_oversized_records']);
    expect(source.health().invalidRecords).toBe(1);
  } finally {
    await source.close();
    await journal.close();
  }
});

it('rejects hard-linked source files while committing adjacent trusted sources', async () => {
  const { directory, journal, source, path } = await setup();
  const privatePath = join(directory, 'unrelated-private-file');
  await writeFile(privatePath, JSON.stringify(event('PRIVATE-UNRELATED')) + '\n');
  await link(privatePath, path);
  await writeFile(
    join(directory, 'desktop.1.ndjson'),
    JSON.stringify(event('trusted_adjacent')) + '\n',
  );
  try {
    await source.poll();
    await journal.flush();
    expect(source.health()).toMatchObject({ copied: 1, error: 'native_source_unavailable' });
    expect((await entries(directory)).text).not.toContain('PRIVATE-UNRELATED');
    await source.poll();
    await journal.flush();
    expect((await entries(directory)).entries.map((record) => record.entry.stage)).toEqual([
      'trusted_adjacent',
    ]);
  } finally {
    await source.close();
    await journal.close();
  }
});
