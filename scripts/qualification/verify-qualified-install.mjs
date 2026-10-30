import { Buffer } from 'node:buffer';
import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { validateReleaseTag } from './app-version.mjs';
import { verifyPayload } from './product-runtime.mjs';
import { verifyQualifiedResources } from '../ci/resource-release.mjs';

// Consume the actual same-run original bytes in isolation after signing. This
// step has no publication authority and never invokes Promotion or production mirrors.
const inputs = process.argv.slice(2);
if (inputs.length !== 3 || inputs.some((value) => !value.trim()))
  throw new Error('Product, resources and verified extracted Core directory are required');
const [product, resources, coreDirectory] = inputs.map((value) => resolve(value));
const isolation = await mkdtemp(join(tmpdir(), 'mizar-qualified-install-'));
try {
  if (!coreDirectory) throw new Error('Verified extracted Core directory is required');
  const coreBytes = await readFile(join(product, 'core-release-manifest.json'));
  const core = JSON.parse(coreBytes);
  const artifact = await verifyPayload(coreDirectory);
  if (
    artifact.appVersion !== core.appVersion ||
    artifact.gitSha !== core.gitSha ||
    artifact.artifactSha256 !== core.contentDigest
  )
    throw new Error('Extracted Core differs from the qualified candidate');
  // The signing job has no checkout node_modules. Load only the verified
  // production SDK and its bundled dependencies from the explicit extraction.
  const sdk = join(coreDirectory, 'resources/app/node_modules/@mizar/resource-pack-contract/dist');
  const { createMizarVerifier, verifyMizarAttestation } = await import(
    pathToFileURL(join(sdk, 'attestation.js')).href
  );
  const { makeMachineMetadata } = await import(pathToFileURL(join(sdk, 'transport.js')).href);
  const full = JSON.parse(await readFile(join(product, 'release-manifest.json')));
  validateReleaseTag(`v${full.appVersion}`, full.appVersion);
  if (full.gitSha !== core.gitSha || full.appVersion !== core.appVersion)
    throw new Error('Qualified Full and Core source differ');
  const stable = /^\d+\.\d+\.\d+$/.test(full.appVersion);
  const bundleBytes = await readFile(join(product, 'qualification-provenance.json'));
  const bundle = JSON.parse(bundleBytes);
  const verifier = await createMizarVerifier(
    'qualification',
    full.gitSha,
    join(isolation, 'trust'),
  );
  const files = new Map([['qualification-provenance.json', bundleBytes]]);
  for (const name of [
    'release-manifest.json',
    'distribution-manifest.json',
    'core-release-manifest.json',
    'core-distribution-manifest.json',
  ]) {
    const bytes = await readFile(join(product, name));
    if (verifyMizarAttestation(bytes, name, bundle, verifier) !== full.gitSha)
      throw new Error('Qualified manifest source differs');
    files.set(name, bytes);
  }
  const distribution = JSON.parse(files.get('core-distribution-manifest.json'));
  if (stable) {
    const bytes = await readFile(join(product, 'update-manifest.json'));
    const update = JSON.parse(bytes);
    if (verifyMizarAttestation(bytes, 'update-manifest.json', bundle, verifier) !== full.gitSha)
      throw new Error('Qualified update source differs');
    const deployed = join(coreDirectory, 'resources/app/dist/updates/core.js');
    const { selectQualifiedCore } = await import(pathToFileURL(deployed).href);
    const selected = selectQualifiedCore(makeMachineMetadata(files), update, verifier);
    if (
      selected.installer.sha256 !== distribution.archiveSha256 ||
      selected.coreArchiveSha256 !== core.archiveSha256
    )
      throw new Error('Client did not select the same-run qualified Core');
  }
  // Both channels verify the real signed Full/Core archives and installers.
  // Only Stable has an update manifest and invokes the deployed update selector.
  for (const name of [
    'release-manifest.json',
    'distribution-manifest.json',
    'core-release-manifest.json',
    'core-distribution-manifest.json',
  ]) {
    const manifest = JSON.parse(files.get(name));
    const { createHash } = await import('node:crypto');
    const asset = await readFile(join(product, manifest.archive));
    if (
      createHash('sha256').update(asset).digest('hex') !== manifest.archiveSha256 ||
      verifyMizarAttestation(asset, manifest.archive, bundle, verifier) !== full.gitSha
    )
      throw new Error('Qualified artifact differs');
  }
  const candidate = await verifyQualifiedResources(resources, core, true);
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
        installerSha256: distribution.archiveSha256,
        stableSelectorVerified: stable,
        resourceSourceSha: candidate.entry.policy.sourceSha,
        resourceSha256: candidate.entry.archive.sha256,
        productionPublicationVerified: false,
      }) + '\n',
    ),
    { flag: 'wx' },
  );
  console.log(
    'PASS: real same-run Qualification signatures consumed by isolated SDK; Stable selector verified when applicable; original resource source retained',
  );
} finally {
  await rm(isolation, { recursive: true, force: true });
}
