import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile, rename, unlink, realpath } from 'node:fs/promises';
import * as filesystem from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { fullLogArchive } from '../../apps/companion/src/support/archive.ts';

vi.mock('node:fs/promises', async (original) => ({
  ...(await original()),
}));

it('reads pinned native producer files through real rotation and unlink on the current OS', async () => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'mizar-archive-snapshot-'));
  const file = (index) => join(directory, index ? `desktop.${index}.ndjson` : 'desktop.ndjson');
  const originalOpen = filesystem.open;
  let rotated = false;
  try {
    for (let index = 0; index < 4; index++) {
      await writeFile(
        file(index),
        Array.from({ length: 10 }, (_, sequence) =>
          JSON.stringify({
            startupSessionId: `original-host-${index}`,
            sequence: sequence + 1,
            time: '2026-10-17T00:00:00.000Z',
            stage: 'native_command',
            detail: `original operation ${index}/${sequence}`,
            result: 'success',
          }),
        ).join('\n') + '\n',
      );
    }
    vi.spyOn(filesystem, 'open').mockImplementation(async (...args) => {
      const handle = await originalOpen(...args);
      if (args[0] === file(3) && !rotated) {
        rotated = true;
        await unlink(file(3));
        for (let index = 2; index >= 0; index--) await rename(file(index), file(index + 1));
        await writeFile(
          file(0),
          JSON.stringify({ startupSessionId: 'new-host-after-snapshot', sequence: 1 }) + '\n',
        );
      }
      return handle;
    });
    const archive = await fullLogArchive(directory);
    const path = join(directory, 'public-test-bundle.json');
    await writeFile(path, JSON.stringify({ schema: 'mizar-support-bundle/1', fullLogs: archive }));
    const output = execFileSync(
      process.execPath,
      ['scripts/diagnostics/read-support-bundle.mjs', path],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const events = output
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(rotated).toBe(true);
    expect(events).toHaveLength(40);
    for (let index = 0; index < 4; index++)
      expect(
        events
          .filter((event) => event.startupSessionId === `original-host-${index}`)
          .map((event) => event.sequence),
      ).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(output).not.toContain('new-host-after-snapshot');
    expect(
      archive.files
        .filter((entry) => /^desktop(?:\.[123])?\.ndjson$/.test(entry.name))
        .map((entry) => entry.status),
    ).toEqual(['read', 'read', 'read', 'read']);
  } finally {
    vi.restoreAllMocks();
    await rm(directory, { recursive: true, force: true });
  }
});
