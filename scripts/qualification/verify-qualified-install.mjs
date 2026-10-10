import { Buffer } from 'node:buffer';
import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, basename, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import {
  createMizarVerifier,
  verifyMizarAttestation,
} from '../../packages/resource-pack-contract/attestation.mjs';
import { makeMachineMetadata } from '../../packages/resource-pack-contract/transport.mjs';
import { verifyQualifiedResources } from '../ci/resource-release.mjs';

// Consume the actual same-run original bytes in isolation after signing. This
// step has no publication authority and never invokes Promotion or production mirrors.
const [product, resources] = process.argv.slice(2).map((value) => resolve(value));
const isolation = await mkdtemp(join(tmpdir(), 'mizar-qualified-install-'));
try {
  const bytes = await readFile(join(product, 'update-manifest.json'));
  const full = JSON.parse(bytes);
  const bundleBytes = await readFile(join(product, 'qualification-provenance.json'));
  const verifier = await createMizarVerifier(
    'qualification',
    full.gitSha,
    join(isolation, 'trust'),
  );
  if (
    verifyMizarAttestation(bytes, 'update-manifest.json', JSON.parse(bundleBytes), verifier) !==
    full.gitSha
  )
    throw new Error('Qualified update source differs');
  const files = new Map([['qualification-provenance.json', bundleBytes]]);
  for (const name of [
    'release-manifest.json',
    'distribution-manifest.json',
    'core-release-manifest.json',
    'core-distribution-manifest.json',
  ])
    files.set(name, await readFile(join(product, name)));
  const core = JSON.parse(files.get('core-release-manifest.json'));
  const deployed = join(
    product,
    basename(core.archive, '.zip'),
    'resources/app/dist/updates/core.js',
  );
  const { selectQualifiedCore } = await import(pathToFileURL(deployed).href);
  const selected = selectQualifiedCore(makeMachineMetadata(files), full, verifier);
  if (
    selected.installer.sha256 !==
      JSON.parse(files.get('core-distribution-manifest.json')).archiveSha256 ||
    selected.coreArchiveSha256 !== core.archiveSha256
  )
    throw new Error('Client did not select the same-run qualified Core');
  for (const [name, digest] of [
    [core.archive, core.archiveSha256],
    [selected.installer.name, selected.installer.sha256],
  ]) {
    const { createHash } = await import('node:crypto');
    const asset = await readFile(join(product, name));
    if (
      createHash('sha256').update(asset).digest('hex') !== digest ||
      verifyMizarAttestation(asset, name, JSON.parse(bundleBytes), verifier) !== full.gitSha
    )
      throw new Error('Qualified Core artifact differs');
  }
  const candidate = await verifyQualifiedResources(resources, core);
  const descriptorVerifier = await createMizarVerifier(
    'qualification',
    core.gitSha,
    join(isolation, 'trust'),
  );
  const archiveVerifier = await createMizarVerifier(
    'qualification',
    candidate.entry.policy.sourceSha,
    join(isolation, 'trust'),
  );
  if (
    verifyMizarAttestation(
      candidate.bytes,
      'resource-descriptor.json',
      JSON.parse(
        await readFile(join(resources, 'resource-descriptor-qualification-provenance.json')),
      ),
      descriptorVerifier,
    ) !== core.gitSha ||
    verifyMizarAttestation(
      candidate.archiveBytes,
      candidate.entry.archive.name,
      JSON.parse(await readFile(join(resources, 'resource-pack-provenance.json'))),
      archiveVerifier,
    ) !== candidate.entry.policy.sourceSha
  )
    throw new Error('Qualified resource original signer differs');
  await writeFile(
    join(product, 'qualified-client-verification.json'),
    Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        sourceSha: full.gitSha,
        coreSha256: core.archiveSha256,
        installerSha256: selected.installer.sha256,
        resourceSourceSha: candidate.entry.policy.sourceSha,
        resourceSha256: candidate.entry.archive.sha256,
        productionPublicationVerified: false,
      }) + '\n',
    ),
    { flag: 'wx' },
  );
  console.log(
    'PASS: real same-run Qualification signatures consumed by isolated SDK and deployed Core selector; original resource source retained',
  );
} finally {
  await rm(isolation, { recursive: true, force: true });
}
