import { createHash } from 'node:crypto';
import { lstat, readFile, writeFile } from 'node:fs/promises';

/** Call during startup before any legacy writer can run. Missing files need no backup. */
export async function backupLegacyConfig(path: string, maxBytes: number): Promise<string | null> {
  let before;
  try {
    before = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > maxBytes)
    throw new Error('legacy_config_invalid');
  const bytes = await readFile(path);
  const after = await lstat(path);
  if (
    !after.isFile() ||
    after.isSymbolicLink() ||
    after.nlink !== 1 ||
    after.size !== before.size ||
    after.mtimeMs !== before.mtimeMs ||
    after.ctimeMs !== before.ctimeMs ||
    after.ino !== before.ino ||
    bytes.length !== before.size
  )
    throw new Error('legacy_config_changed');
  const digest = createHash('sha256').update(bytes).digest('hex');
  const backup = `${path}.backup-${digest}`;
  try {
    await writeFile(backup, bytes, { flag: 'wx', mode: 0o600, flush: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const stat = await lstat(backup);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1 ||
      stat.size !== bytes.length ||
      createHash('sha256')
        .update(await readFile(backup))
        .digest('hex') !== digest
    )
      throw new Error('legacy_backup_invalid', { cause: error });
  }
  return digest;
}
