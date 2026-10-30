import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { zipSync } from 'fflate';
import { parseHudResolvedPreset } from '@mizar/hud-config';
import { resolvedHudSchema } from '@mizar/broadcast-config';
import { legacyOverlays } from '../broadcast-config/migrate.js';

const MAX_FILES = 4096;
const MAX_BYTES = 64 * 1024 * 1024;

/** Build a ZIP only from the shipped runtime, built-in media and the selected snapshot. */
export async function exportLhmHud(webRoot: string, value: unknown): Promise<Buffer> {
  const parsed = resolvedHudSchema.safeParse(value);
  const preset = parsed.success
    ? parsed.data
    : (() => {
        const config = parseHudResolvedPreset(value);
        return {
          renderer: 'native' as const,
          config,
          overlays: legacyOverlays(config.layout, config.widgets),
          accent: { source: 'fixed' as const, value: config.theme.brandColor },
        };
      })();
  if (preset.renderer !== 'native') throw new Error('lhm_export_unsupported_hud');
  const files: Record<string, Uint8Array> = Object.create(null) as Record<string, Uint8Array>;
  let total = 0;
  const add = (name: string, bytes: Uint8Array) => {
    if (Object.hasOwn(files, name) || ++count > MAX_FILES || (total += bytes.length) > MAX_BYTES)
      throw new Error('lhm_export_budget');
    files[name] = bytes;
  };
  let count = 0;
  const visit = async (directory: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (
        entry.isSymbolicLink() ||
        !/^[A-Za-z0-9_. -]+$/.test(entry.name) ||
        entry.name === '.' ||
        entry.name === '..'
      )
        throw new Error('lhm_export_invalid_asset');
      const path = join(directory, entry.name);
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await visit(path, name);
      else if (entry.isFile()) {
        if ((await stat(path)).size > MAX_BYTES - total) throw new Error('lhm_export_budget');
        add(name, await readFile(path));
      } else throw new Error('lhm_export_invalid_asset');
    }
  };
  await visit(join(webRoot, 'lhm-runtime'), '');
  if (!files['index.html']) throw new Error('lhm_export_runtime_missing');
  await visit(join(webRoot, 'brand'), 'mizar-assets/brand');
  await visit(join(webRoot, 'assets/cs2'), 'mizar-assets/assets/cs2');
  const json = (value: unknown) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  add(
    'hud.json',
    json({
      name: 'Mizar HUD',
      version: '1.0.0',
      author: 'Mizar',
      legacy: false,
      radar: true,
      killfeed: false,
      game: 'cs2',
      boltobserv: { css: false, maps: false },
    }),
  );
  add('panel.json', json([]));
  add('keybinds.json', json([]));
  add('mizar-config.json', json(preset));
  add(
    'mizar-export-report.json',
    json({
      included: [
        'hud-layout',
        'theme',
        'built-in-media',
        'gsi-gameplay',
        'match-series',
        'team-identity',
        'team-logos',
        'player-avatars',
      ],
      unsupported: [
        'program-scenes',
        'music',
        'camera-control',
        'bomb-damage-prediction',
        'bo2-match-series',
        'hud-actions',
      ],
      needsBinding: ['lhm-or-jt-host', 'host-match-and-media'],
    }),
  );
  return Buffer.from(zipSync(files, { level: 6, mtime: new Date('1980-01-01T00:00:00Z') }));
}
