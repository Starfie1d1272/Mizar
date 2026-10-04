import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
const appDir = resolve(process.argv[2] ?? 'apps/companion');
const requireFromApp = createRequire(resolve(appDir, 'package.json'));
const { loadBundledMap } = requireFromApp('cs2-c4-damage/node');
const { bundledMapManifest } = requireFromApp('cs2-c4-damage/maps');
const { createStandingC4Predictor } = requireFromApp('cs2-c4-damage');
const packageRoot = resolve(requireFromApp.resolve('cs2-c4-damage'), '..', '..');
for (const file of ['NOTICE', 'CREDITS.md', 'LICENSE']) await readFile(resolve(packageRoot, file));
const maps = bundledMapManifest.maps;
if (maps.length !== 10) throw new Error('Expected ten bundled maps');
for (const map of maps) {
  const field = await loadBundledMap(map.mapName);
  if (field.metadata.normalizedFieldSha256 !== map.normalizedFieldSha256)
    throw new Error('Resource identity mismatch');
  const predict = createStandingC4Predictor(field);
  const site = field.bombsites[0];
  const outcome = predict({
    bombPosition: {
      x: (site.boundsMin.x + site.boundsMax.x) / 2,
      y: (site.boundsMin.y + site.boundsMax.y) / 2,
      z: (site.boundsMin.z + site.boundsMax.z) / 2,
    },
    playerPosition: field.positions[0],
    playerForward: { x: 1, y: 0, z: 0 },
    health: 100,
  });
  if (!['predicted', 'unavailable'].includes(outcome.status))
    throw new Error('Invalid installed prediction');
  process.stdout.write(`${map.mapName}: verified\n`);
}
