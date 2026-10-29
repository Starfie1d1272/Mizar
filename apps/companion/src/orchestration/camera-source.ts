import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

/** Hash the original source tree, before any Mizar conversion or machine configuration. */
export async function cameraSourceTreeSha256(root: string): Promise<string> {
  const entries: Array<[string, 'directory'] | [string, 'file', number, string]> = [];
  let bytes = 0;
  const visit = async (path: string, relative: string, depth: number): Promise<void> => {
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || depth > 8 || ++count > 4096) throw new Error('pack_unsafe_entry');
    if (stat.isDirectory()) {
      if (relative) entries.push([relative, 'directory']);
      const names = await readdir(path);
      const folded = new Set<string>();
      for (const name of names.sort()) {
        if (name.includes('\\') || name === '.' || name === '..' || folded.has(name.toLowerCase()))
          throw new Error('pack_unsafe_entry');
        folded.add(name.toLowerCase());
        await visit(join(path, name), relative ? `${relative}/${name}` : name, depth + 1);
      }
    } else if (stat.isFile() && stat.nlink === 1) {
      if ((bytes += stat.size) > 64 * 1024 * 1024) throw new Error('pack_too_large');
      const content = await readFile(path);
      const after = await lstat(path);
      if (
        !after.isFile() ||
        after.isSymbolicLink() ||
        after.nlink !== 1 ||
        content.length !== stat.size ||
        after.size !== stat.size ||
        after.mtimeMs !== stat.mtimeMs ||
        after.ino !== stat.ino
      )
        throw new Error('pack_source_changed');
      entries.push([
        relative,
        'file',
        content.length,
        createHash('sha256').update(content).digest('hex'),
      ]);
    } else throw new Error('pack_unsafe_entry');
  };
  let count = 0;
  await visit(root, '', 0);
  return createHash('sha256').update(JSON.stringify(entries), 'utf8').digest('hex');
}
