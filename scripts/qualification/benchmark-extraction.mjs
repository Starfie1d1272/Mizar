import { execFileSync } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { readMachineMetadata } from '../../packages/resource-pack-contract/transport.mjs';
import { verifyPayload } from './product-runtime.mjs';
import { releaseAttestationArgs } from './release-identity.mjs';

if (process.platform !== 'win32') throw new Error('Extraction benchmark requires Windows');
const root = resolve('.agent-tmp/release-extraction-benchmark');
await mkdir(root, { recursive: true });
const name = 'Mizar-v1.3.0-Windows-x64.zip';
const sourceSha = '433c86836cfc36224bdadb17928cff58385f2c7b';
const expectedHash = '039d37f22a5a1b23f9cf64392e10f59f80ee261ee444b899b115c28993c27030';
execFileSync(
  'gh',
  [
    'release',
    'download',
    'v1.3.0',
    '--repo',
    'Starfie1d1272/Mizar',
    '--pattern',
    name,
    '--pattern',
    'machine-metadata.json',
    '--dir',
    root,
  ],
  { stdio: 'inherit', timeout: 180000 },
);
const bytes = await readFile(join(root, name));
if (createHash('sha256').update(bytes).digest('hex') !== expectedHash)
  throw new Error('Published benchmark ZIP differs from the pinned original');
const metadata = readMachineMetadata(await readFile(join(root, 'machine-metadata.json')));
const bundle = join(root, 'qualification-provenance.json');
await writeFile(bundle, metadata.get('qualification-provenance.json'));
execFileSync('gh', releaseAttestationArgs(join(root, name), sourceSha, bundle), {
  stdio: 'inherit',
  timeout: 120000,
});
const manifest = JSON.parse(metadata.get('release-manifest.json'));
if (manifest.gitSha !== sourceSha || manifest.archiveSha256 !== expectedHash)
  throw new Error('Benchmark metadata differs from the original ZIP');
const measurements = [];
// ABBA avoids crediting only filesystem warming to the candidate extractor.
for (const [index, mode] of ['powershell', 'native', 'native', 'powershell'].entries()) {
  const destination = join(root, 'extracted ' + index);
  const literal = (value) => "'" + value.replaceAll("'", "''") + "'";
  const started = performance.now();
  execFileSync(
    'pwsh',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      mode === 'native'
        ? `& ./scripts/qualification/extract-windows-shell.ps1 -Archive ${literal(join(root, name))} -Destination ${literal(destination)} -Native`
        : `Expand-Archive -LiteralPath ${literal(join(root, name))} -DestinationPath ${literal(destination)}`,
    ],
    { stdio: 'inherit', timeout: 180000 },
  );
  const extractionMs = Math.round(performance.now() - started);
  const verified = await verifyPayload(join(destination, name.slice(0, -4)));
  if (verified.artifactSha256 !== manifest.contentDigest || verified.gitSha !== sourceSha)
    throw new Error('Extracted benchmark payload differs');
  measurements.push({ mode, extractionMs, payloadVerified: true });
  await rm(destination, { recursive: true });
}
const report = { sourceSha, archiveSha256: expectedHash, measurements, publication: false };
await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report));
