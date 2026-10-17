import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, readdir, realpath, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolatedMetadata, verifyIsolatedPack } from './isolated-pack.js';

/** Create a separate pack; never modify a user's original pack or import bundled resources. */
export async function prepareIsolatedPack(source: string, root: string) {
  const from = await realpath(source),
    to = await realpath(root);
  const name = `Mizar_${randomBytes(12).toString('hex')}`;
  const target = join(to, name);
  await mkdir(target); // Exclusive; partial copies never get valid metadata.
  let files = 0,
    bytes = 0;
  const copy = async (src: string, dest: string, depth: number) => {
    const stat = await lstat(src);
    if (stat.isSymbolicLink() || depth > 8) throw new Error('pack_unsafe_entry');
    if (stat.isDirectory()) {
      await mkdir(dest);
      for (const entry of await readdir(src))
        await copy(join(src, entry), join(dest, entry), depth + 1);
    } else if (stat.isFile() && stat.nlink === 1) {
      if (++files > 4096 || (bytes += stat.size) > 64 * 1024 * 1024)
        throw new Error('pack_too_large');
      await copyFile(src, dest, constants.COPYFILE_EXCL);
    } else throw new Error('pack_unsafe_entry');
  };
  // These are MulNX's resource directories; no original automatic triggers are copied.
  for (const dir of ['CamMacros', 'Campaths']) await copy(join(from, dir), join(target, dir), 0);
  await writeFile(join(target, `${name}.yaml`), isolatedMetadata(name), { flag: 'wx' });
  if (!verifyIsolatedPack(to, name)) throw new Error('pack_verification_failed');
  return { name, files, bytes };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [source, root, extra] = process.argv.slice(2);
  if (!source || !root || extra)
    throw new Error('Usage: prepare-pack.js <source-pack-folder> <MulNX-CamPacks-root>');
  console.log(JSON.stringify(await prepareIsolatedPack(source, root)));
}
