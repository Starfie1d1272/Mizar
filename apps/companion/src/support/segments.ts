import { join } from 'node:path';
import { readdir, lstat } from 'node:fs/promises';
/** Immutable segment names are never recycled. Legacy sources remain read-only until migration. */
export const diagnosticSegmentPattern =
  /^(?:session|desktop|document|migrated)-[a-f0-9-]{36}\.ndjson$/;
export async function diagnosticSegmentNames(directory: string): Promise<string[]> {
  const entries = await Promise.all(
    (await readdir(directory))
      .filter((name) => diagnosticSegmentPattern.test(name))
      .map(async (name) => {
        try {
          return { name, time: (await lstat(join(directory, name))).birthtimeMs };
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
          throw error;
        }
      }),
  );
  return entries
    .filter((entry): entry is { name: string; time: number } => entry !== null)
    .sort((a, b) => a.time - b.time || a.name.localeCompare(b.name))
    .map((entry) => entry.name);
}
