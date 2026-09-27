import { readFile, writeFile } from 'node:fs/promises';
import { URL, fileURLToPath } from 'node:url';
import prettier from 'prettier';

import { RIVALS_BP_RECORDS } from '../../packages/rivalhub/dist/demo/rivals-bp-records.js';

const outputPath = fileURLToPath(
  new URL('../../apps/web/src/program/fixtures/rivals-bp-records.generated.ts', import.meta.url),
);
const source = `// Generated from packages/rivalhub/src/demo/rivals-bp-records.ts. Do not edit by hand.\nexport const RIVALS_BP_RECORDS = ${JSON.stringify(RIVALS_BP_RECORDS, null, 2)} as const;\n`;
const prettierOptions = (await prettier.resolveConfig(outputPath)) ?? {};
const rendered = await prettier.format(source, { ...prettierOptions, filepath: outputPath });

if (process.argv.includes('--check')) {
  const current = await readFile(outputPath, 'utf8');
  if (current !== rendered) {
    process.stderr.write(
      'RivalHub BP Program fixture is stale. Run pnpm fixtures:rivals-bp:sync.\n',
    );
    process.exitCode = 1;
  }
} else {
  await writeFile(outputPath, rendered, 'utf8');
}
