import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

/** JSON is valid YAML for MulNX; restrict accepted metadata to known safe encodings. */
export function isolatedMetadata(name: string) {
  return (
    JSON.stringify(
      {
        name,
        KCP: { usable: false, ctrl: false, shift: false, alt: false, vkCode: 0, comboClick: 1 },
        OnNewRound: [],
        OnRoundStart: [],
        OnRoundEnd: [],
      },
      null,
      2,
    ) + '\n'
  );
}
/** MulNX rewrites a loaded pack in this exact YAML form when switching packs. */
function mulnxMetadata(name: string) {
  return [
    `name: ${name}`,
    'KCP:',
    '  usable: false',
    '  ctrl: false',
    '  shift: false',
    '  alt: false',
    '  vkCode: 0',
    '  comboClick: 1',
    'OnNewRound:',
    '  []',
    'OnRoundStart:',
    '  []',
    'OnRoundEnd:',
    '  []',
  ].join('\n');
}
/** Disk prerequisite only: MulNX exposes no active-pack/load-state readback. */
export function verifyIsolatedPack(root: string | undefined, name: string): boolean {
  if (!root || !/^Mizar_[a-f0-9]{24}$/.test(name)) return false;
  try {
    const pack = join(realpathSync(root), name);
    if (!lstatSync(pack).isDirectory() || lstatSync(pack).isSymbolicLink()) return false;
    const path = join(pack, `${name}.yaml`);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 4096)
      return false;
    const content = readFileSync(path, 'utf8');
    return (
      content === isolatedMetadata(name) ||
      content.replaceAll('\r\n', '\n').replace(/\n$/, '') === mulnxMetadata(name)
    );
  } catch {
    return false;
  }
}
