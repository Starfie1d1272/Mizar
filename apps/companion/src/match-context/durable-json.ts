import { randomUUID } from 'node:crypto';
import { renameSync } from 'node:fs';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

export type DurableJsonCommitPoint = 'before-write' | 'after-write' | 'before-rename';

/** Test-only fault injection hook for exercising the atomic replace boundary. */
export type DurableJsonFaultInjector = (point: DurableJsonCommitPoint) => void;

export interface DurableJsonReplaceOptions {
  readonly canCommit?: () => boolean;
  readonly faultInjector?: DurableJsonFaultInjector;
}

/**
 * Replace one JSON document through a same-directory temporary file and one
 * atomic rename. The optional guard is checked again immediately before the
 * synchronous rename so a superseded request cannot publish its envelope.
 */
export async function replaceDurableJson(
  filePath: string,
  value: unknown,
  options: DurableJsonReplaceOptions = {},
): Promise<boolean> {
  if (options.canCommit !== undefined && !options.canCommit()) return false;

  await mkdir(dirname(filePath), { recursive: true });
  const temporaryPath = join(
    dirname(filePath),
    `.${basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );

  try {
    options.faultInjector?.('before-write');
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flush: true,
    });
    options.faultInjector?.('after-write');
    if (options.canCommit !== undefined && !options.canCommit()) return false;
    options.faultInjector?.('before-rename');

    // Keep the guard and the one-file replace in the same synchronous turn.
    renameSync(temporaryPath, filePath);
    return true;
  } finally {
    try {
      await unlink(temporaryPath);
    } catch {
      // The temporary file is already gone after a successful rename.
    }
  }
}
