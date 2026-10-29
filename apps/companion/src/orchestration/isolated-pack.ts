import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { parseDocument } from 'yaml';

export function validKeyCheckPack(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const key = value as Record<string, unknown>;
  return (
    ['usable', 'ctrl', 'shift', 'alt'].every((field) => typeof key[field] === 'boolean') &&
    ['vkCode', 'comboClick'].every(
      (field) =>
        typeof key[field] === 'number' &&
        Number.isInteger(key[field]) &&
        key[field] >= -2147483648 &&
        key[field] <= 2147483647,
    )
  );
}

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
/** Disk prerequisite only; it does not establish the active in-memory pack. */
export function verifyIsolatedPack(root: string | undefined, name: string): boolean {
  if (!root || !/^Mizar_[a-f0-9]{24}$/.test(name)) return false;
  try {
    const pack = join(realpathSync(root), name);
    if (!lstatSync(pack).isDirectory() || lstatSync(pack).isSymbolicLink()) return false;
    const path = join(pack, `${name}.yaml`);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 4096)
      return false;
    const document = parseDocument(readFileSync(path, 'utf8'), { uniqueKeys: true });
    if (document.errors.length || document.warnings.length) return false;
    const metadata: unknown = document.toJS({ maxAliasCount: 0 });
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return false;
    const value = metadata as Record<string, unknown>;
    const shortcut = value.KCP;
    return (
      value.name === name &&
      validKeyCheckPack(shortcut) &&
      (shortcut as Record<string, unknown>).usable === false &&
      ['OnNewRound', 'OnRoundStart', 'OnRoundEnd'].every(
        (key) => Array.isArray(value[key]) && value[key].length === 0,
      )
    );
  } catch {
    return false;
  }
}
