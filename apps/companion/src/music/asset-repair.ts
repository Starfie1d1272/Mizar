import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { safePath } from '../resource-store/files.js';

const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const identity = (stat: Awaited<ReturnType<typeof lstat>>) =>
  JSON.stringify([stat.dev, stat.ino, stat.nlink, stat.size, stat.mtimeMs, stat.ctimeMs]);

/** Preserve damaged owned bytes before an explicitly requested replacement of the same asset. */
export async function preserveDamagedTrack(directory: string, id: string) {
  const path = await safePath(join(directory, 'tracks'), id);
  const before = await lstat(path);
  if (before.size > 32 * 1024 * 1024) throw new Error('music_track_invalid');
  const bytes = await readFile(path);
  const sha256 = digest(bytes);
  const unchanged = async () => {
    await safePath(join(directory, 'tracks'), id);
    if (identity(await lstat(path)) !== identity(before)) throw new Error('music_track_changed');
  };
  await unchanged();
  if (bytes.length !== before.size) throw new Error('music_track_changed');
  const backupName = `${id}.damaged-${sha256}-${randomUUID()}`;
  const backup = join(directory, 'tracks', backupName);
  // Each attempt owns a new backup. A partial older backup cannot block a later recovery.
  await writeFile(backup, bytes, { flag: 'wx', mode: 0o600, flush: true });
  // A failed backup never authorizes replacement.
  await safePath(join(directory, 'tracks'), backupName);
  if ((await lstat(backup)).size !== bytes.length || digest(await readFile(backup)) !== sha256)
    throw new Error('music_track_backup_invalid');
  await unchanged();
  return unchanged;
}
