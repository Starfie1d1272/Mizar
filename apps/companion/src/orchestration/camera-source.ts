import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { disableMacroShortcut } from './isolated-pack.js';

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

/** Verify the files actually used by the isolated pack against converter v1 output. */
export async function verifyCameraConversion(source: string, target: string): Promise<boolean> {
  try {
    const targetEntries = (await readdir(target)).sort();
    const name = target.split(/[\\/]/).at(-1)!;
    if (
      JSON.stringify(targetEntries) !==
      JSON.stringify([`${name}.yaml`, 'CamMacros', 'Campaths'].sort())
    )
      return false;
    let count = 0,
      bytes = 0;
    const compare = async (
      from: string,
      to: string,
      depth: number,
      macro: boolean,
    ): Promise<boolean> => {
      const sourceStat = await lstat(from).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return undefined;
        throw error;
      });
      const targetStat = await lstat(to);
      if (++count > 4096 || depth > 8 || targetStat.isSymbolicLink()) return false;
      if (!sourceStat)
        return depth === 0 && targetStat.isDirectory() && (await readdir(to)).length === 0;
      if (sourceStat.isSymbolicLink()) return false;
      if (sourceStat.isDirectory() && targetStat.isDirectory()) {
        const fromNames = (await readdir(from)).sort(),
          toNames = (await readdir(to)).sort();
        if (JSON.stringify(fromNames) !== JSON.stringify(toNames)) return false;
        for (const entry of fromNames)
          if (!(await compare(join(from, entry), join(to, entry), depth + 1, macro))) return false;
        return true;
      }
      if (
        !sourceStat.isFile() ||
        !targetStat.isFile() ||
        sourceStat.nlink !== 1 ||
        targetStat.nlink !== 1 ||
        (bytes += sourceStat.size) > 64 * 1024 * 1024 ||
        targetStat.size > 64 * 1024 * 1024 ||
        (macro && (depth !== 1 || sourceStat.size > 1024 * 1024))
      )
        return false;
      const original = await readFile(from),
        actual = await readFile(to);
      const expected = macro
        ? Buffer.from(disableMacroShortcut(original.toString('utf8')))
        : original;
      return expected.equals(actual);
    };
    return (
      (await compare(join(source, 'CamMacros'), join(target, 'CamMacros'), 0, true)) &&
      (await compare(join(source, 'Campaths'), join(target, 'Campaths'), 0, false))
    );
  } catch {
    return false;
  }
}
