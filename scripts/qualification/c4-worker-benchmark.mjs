import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { writeFile } from 'node:fs/promises';
const appRoot = resolve(process.argv[2] ?? 'apps/companion');
const { probeC4Worker } = await import(
  pathToFileURL(join(appRoot, 'dist/projections/bomb-damage-benchmark.js'))
);
const report = await probeC4Worker();
if (process.argv[3]) await writeFile(process.argv[3], `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report));
