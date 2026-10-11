import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { readMachineMetadata } from '../../packages/resource-pack-contract/transport.mjs';
import { releaseAttestationArgs } from './release-identity.mjs';

const startedAt = new Date().toISOString();
const wallStart = performance.now();
const root = resolve('.agent-tmp/release-provenance-benchmark');
await mkdir(root, { recursive: true });
const sourceSha = '433c86836cfc36224bdadb17928cff58385f2c7b';
execFileSync(
  'gh',
  [
    'release',
    'download',
    'v1.3.0',
    '--repo',
    'Starfie1d1272/Mizar',
    '--pattern',
    'machine-metadata.json',
    '--dir',
    root,
  ],
  { timeout: 180000, stdio: 'pipe' },
);
const metadata = readMachineMetadata(await readFile(join(root, 'machine-metadata.json')));
const bundle = join(root, 'qualification-provenance.json');
await writeFile(bundle, metadata.get('qualification-provenance.json'));
const subjects = [
  'release-manifest.json',
  'core-release-manifest.json',
  'distribution-manifest.json',
];
for (const name of subjects) await writeFile(join(root, name), metadata.get(name));
const measurements = [];
// Keep verifiers serial: earlier concurrent gh verifiers failed during trust initialization.
for (const mode of ['remote', 'bundle', 'bundle', 'remote']) {
  for (const name of subjects) {
    const start = performance.now();
    let verified = false;
    try {
      execFileSync(
        'gh',
        releaseAttestationArgs(join(root, name), sourceSha, mode === 'bundle' ? bundle : undefined),
        { timeout: 120000, maxBuffer: 2 * 1024 * 1024, stdio: 'pipe' },
      );
      verified = true;
    } catch {
      /* Report failure without exposing temporary signed URLs in gh stderr. */
    }
    measurements.push({
      mode,
      subject: name,
      verified,
      durationMs: Math.round(performance.now() - start),
    });
  }
}
const altered = join(root, 'altered-manifest.json');
await writeFile(altered, Buffer.concat([metadata.get('release-manifest.json'), Buffer.from(' ')]));
const malformed = join(root, 'malformed-provenance.json');
await writeFile(malformed, '{}');
const negativeChecks = [];
for (const [name, args] of [
  ['altered bytes', releaseAttestationArgs(altered, sourceSha, bundle)],
  ['wrong source', releaseAttestationArgs(join(root, subjects[0]), 'a'.repeat(40), bundle)],
  [
    'wrong signer workflow',
    releaseAttestationArgs(join(root, subjects[0]), sourceSha, bundle, 'promotion'),
  ],
  ['malformed bundle', releaseAttestationArgs(join(root, subjects[0]), sourceSha, malformed)],
]) {
  let rejected = false;
  try {
    execFileSync('gh', args, { timeout: 120000, stdio: 'pipe' });
  } catch {
    rejected = true;
  }
  negativeChecks.push({ name, rejected });
}
const report = {
  sourceSha,
  startedAt,
  finishedAt: new Date().toISOString(),
  wallMs: Math.round(performance.now() - wallStart),
  measurements,
  negativeChecks,
  publication: false,
};
await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report));
if (measurements.some((result) => result.mode === 'bundle' && !result.verified))
  throw new Error('Pinned original qualification bundle verification failed');
if (negativeChecks.some((check) => !check.rejected))
  throw new Error('Provenance negative control was unexpectedly accepted');
