import { createHash } from 'node:crypto';
import { lstat, mkdir, open, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { safePath, syncDirectory } from '../resource-store/files.js';

/** A marker is created and synced before sending, and never means execution succeeded. */
export async function reserveObserverConnect(
  directory: string | undefined,
  game: string,
  intentId: string,
): Promise<'reserved' | 'previous'> {
  if (!directory || !/^\d+-\d+$/.test(game) || !/^[0-9a-f-]{36}$/i.test(intentId))
    throw new Error('observer_connect_reservation_unavailable');
  await safePath(dirname(directory));
  await mkdir(directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'EEXIST') throw error;
  });
  await safePath(directory);
  await syncDirectory(dirname(directory));
  const key = createHash('sha256').update(JSON.stringify([game, intentId])).digest('hex');
  try {
    await lstat(join(directory, key));
    return 'previous';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  // Never evict a marker without proving that its game can no longer return.
  if ((await readdir(directory)).length >= 1024) throw new Error('observer_connect_reservation_full');
  let file;
  try {
    file = await open(join(directory, key), 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return 'previous';
    throw error;
  }
  try {
    await file.sync();
    await syncDirectory(directory);
  } finally {
    await file.close();
  }
  return 'reserved';
}
