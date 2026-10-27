import { randomUUID } from 'node:crypto';
import { link, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { z } from 'zod';

const schema = z
  .object({
    endpoint: z.string().min(1),
    collection: z.string().min(1),
    uuid: z.string().min(1),
    window: z.string().min(1),
  })
  .strict();
export type OwnedCommentaryTarget = z.infer<typeof schema>;
export async function readOwnedCommentaryTarget(
  path: string,
): Promise<OwnedCommentaryTarget | null> {
  try {
    return schema.parse(JSON.parse(await readFile(path, 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
export async function saveOwnedCommentaryTarget(
  path: string,
  target: OwnedCommentaryTarget,
): Promise<void> {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify(schema.parse(target))}\n`, { mode: 0o600 });
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true });
  }
}

/** Create a new baseline without replacing another transaction's record. */
export async function createOwnedCommentaryTarget(
  path: string,
  target: OwnedCommentaryTarget,
): Promise<() => Promise<void>> {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify(schema.parse(target))}\n`, { flag: 'wx', mode: 0o600 });
    const created = await stat(temp);
    await link(temp, path);
    return async () => {
      const quarantine = `${path}.${randomUUID()}.cleanup`;
      try {
        const current = await stat(path);
        if (current.dev !== created.dev || current.ino !== created.ino) return;
        // Rename first, then verify the moved file. Another writer may have
        // replaced the path after stat; never unlink that writer's record.
        await rename(path, quarantine);
        const moved = await stat(quarantine);
        if (moved.dev === created.dev && moved.ino === created.ino) {
          await rm(quarantine);
        } else {
          // Exclusive restoration cannot overwrite a newer record. If it
          // collides, retain the moved file for manual review.
          await link(quarantine, path);
          await rm(quarantine);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    };
  } finally {
    await rm(temp, { force: true });
  }
}
