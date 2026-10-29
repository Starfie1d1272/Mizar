import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { backupLegacyConfig } from '../../src/broadcast-config/legacy-backup.js';

it('keeps a content-addressed backup without changing the source and reuses it safely', async () => {
  const root = await mkdtemp(join(tmpdir(), 'broadcast-backup-'));
  try {
    const path = join(root, 'settings.json');
    expect(await backupLegacyConfig(path, 1024)).toBeNull();
    await writeFile(path, '{"old":true}\n');
    const digest = await backupLegacyConfig(path, 1024);
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
    expect(await backupLegacyConfig(path, 1024)).toBe(digest);
    expect(await readFile(`${path}.backup-${digest}`, 'utf8')).toBe(await readFile(path, 'utf8'));
    await writeFile(`${path}.backup-${digest}`, 'corrupted');
    await expect(backupLegacyConfig(path, 1024)).rejects.toThrow('legacy_backup_invalid');
    expect(await readFile(path, 'utf8')).toBe('{"old":true}\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
