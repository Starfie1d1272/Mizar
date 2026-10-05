import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { format } from 'prettier';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultMapGeometryProvider, projectWorldRadius } from '@mizar/radar';
import { RADAR_MAP_ASSETS, getCs2Asset, resolveCs2ItemByGsiName } from '@mizar/cs2-assets';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const pkg = resolve(root, 'packages/radar-view');
const maps = {};
const icons = {};
const paths = new Map();
for (const [key, artwork] of Object.entries(RADAR_MAP_ASSETS)) {
  const geometry = defaultMapGeometryProvider.resolve(key);
  if (!geometry) throw new Error(`Missing calibration: ${key}`);
  maps[key] = {
    mapKey: key,
    calibrationRevision: geometry.calibrationRevision,
    layers: geometry.layerRule.kind === 'single' ? ['single'] : ['upper', 'lower'],
    unitRadius: projectWorldRadius(1, geometry),
    artwork: Object.fromEntries(
      Object.entries(artwork).map(([layer, asset]) => {
        paths.set(asset.outputPath, asset.outputSha256);
        return [layer, asset.outputPath];
      }),
    ),
  };
}
for (const name of ['smokegrenade', 'flashbang', 'hegrenade', 'decoy', 'molotov', 'incgrenade']) {
  const item = resolveCs2ItemByGsiName(`weapon_${name}`);
  if (item.kind !== 'known') throw new Error(`Missing utility: ${name}`);
  icons[`weapon_${name}`] = item.asset.outputPath;
  paths.set(item.asset.outputPath, item.asset.outputSha256);
}
const bombAsset = getCs2Asset('objective.c4');
const bomb = bombAsset.outputPath;
paths.set(bomb, bombAsset.outputSha256);
await rm(resolve(pkg, 'dist'), { recursive: true, force: true });
for (const [path, hash] of paths) {
  const target = resolve(pkg, 'dist/assets', path.replace(/^\//, ''));
  await mkdir(dirname(target), { recursive: true });
  const bytes = await readFile(
    resolve(root, 'packages/cs2-assets/generated/public', path.replace(/^\//, '')),
  );
  if (createHash('sha256').update(bytes).digest('hex') !== hash)
    throw new Error(`Asset hash mismatch: ${path}`);
  await writeFile(target, bytes);
}
await mkdir(resolve(pkg, 'src'), { recursive: true });
await writeFile(
  resolve(pkg, 'src/assets.generated.ts'),
  await format(
    '// Generated from @mizar/radar and @mizar/cs2-assets; do not edit.\nexport const radarAssets = ' +
      JSON.stringify({ maps, icons, bomb }, null, 2) +
      ' as const;\n',
    { parser: 'typescript', singleQuote: true, printWidth: 96 },
  ),
);
for (const name of ['LICENSE', 'THIRD-PARTY-NOTICES.md'])
  await writeFile(resolve(pkg, 'dist', name), await readFile(resolve(root, name)));

await copyFile(
  resolve(root, 'packages/cs2-assets/generated/radar-maps.json'),
  resolve(pkg, 'dist/radar-provenance.json'),
);

await copyFile(
  resolve(root, 'packages/cs2-assets/generated/manifest.json'),
  resolve(pkg, 'dist/icon-provenance.json'),
);

for (const name of ['playerBg.png', 'shootFire.png']) {
  const target = resolve(pkg, 'dist/assets/brand/hud/esl', name);
  await mkdir(dirname(target), { recursive: true });
  await copyFile(resolve(pkg, 'assets/radar-reference/esl', name), target);
}

await copyFile(
  resolve(pkg, 'assets/radar-reference/esl/SOURCE.md'),
  resolve(pkg, 'dist/esl-artwork-provenance.md'),
);
