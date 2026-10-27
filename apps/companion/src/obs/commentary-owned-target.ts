import { randomUUID } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
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
