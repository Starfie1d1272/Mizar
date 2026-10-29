import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
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

export function disableMacroShortcut(content: string): string {
  const document = parseDocument(content, { uniqueKeys: true });
  if (document.errors.length || document.warnings.length) throw new Error('pack_macro_invalid');
  const value: unknown = document.toJS({ maxAliasCount: 0 });
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('pack_macro_invalid');
  const shortcut = (value as Record<string, unknown>).KCP;
  if (!validKeyCheckPack(shortcut)) throw new Error('pack_macro_invalid');
  document.setIn(['KCP', 'usable'], false);
  return document.toString();
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
    if (!(
      value.name === name &&
      validKeyCheckPack(shortcut) &&
      (shortcut as Record<string, unknown>).usable === false &&
      ['OnNewRound', 'OnRoundStart', 'OnRoundEnd'].every(
        (key) => Array.isArray(value[key]) && value[key].length === 0,
      )
    ))
      return false;
    const macros = join(pack, 'CamMacros');
    const macroStat = lstatSync(macros);
    if (!macroStat.isDirectory() || macroStat.isSymbolicLink()) return false;
    const entries = readdirSync(macros);
    if (entries.length > 4096) return false;
    for (const entry of entries) {
      const file = join(macros, entry);
      const info = lstatSync(file);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 1024 * 1024)
        return false;
      const doc = parseDocument(readFileSync(file, 'utf8'), { uniqueKeys: true });
      if (doc.errors.length || doc.warnings.length) return false;
      const macro: unknown = doc.toJS({ maxAliasCount: 0 });
      if (!macro || typeof macro !== 'object' || Array.isArray(macro)) return false;
      const kcp = (macro as Record<string, unknown>).KCP;
      if (!validKeyCheckPack(kcp) || (kcp as Record<string, unknown>).usable !== false)
        return false;
    }
    return true;
  } catch {
    return false;
  }
}
