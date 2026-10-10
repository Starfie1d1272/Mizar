import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertQualificationIdentity } from '../qualification/release-identity.mjs';
import { qualifiedUpdateManifest } from '../qualification/update-manifest.mjs';
import { verifyPayload } from '../qualification/product-runtime.mjs';

async function identity(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return { bytes: (await stat(path)).size, sha256: hash.digest('hex') };
}
// Only the existing main Qualification producer can authorize embedded executable pins.
// No mirror hashes, caller-supplied plan, development Core or second trust verifier.
export async function qualificationPlan(product, coreRoot, context, checkedOutSha, requestedSha) {
  const release = JSON.parse(await readFile(join(product, 'release-manifest.json'), 'utf8'));
  assertQualificationIdentity(context, checkedOutSha, requestedSha, release.gitSha);
  const manifest = await qualifiedUpdateManifest(product);
  if (!manifest) throw new Error('A stable qualified update manifest is required');
  const coreName = `Mizar-v${manifest.version}-Windows-x64.zip`;
  if (release.archive !== coreName) throw new Error('Noncanonical Core archive');
  const artifact = await verifyPayload(coreRoot);
  if (
    artifact.appVersion !== manifest.version ||
    artifact.desktopBuildProfile !== 'release' ||
    artifact.gitSha !== manifest.gitSha ||
    artifact.artifactSha256 !== release.contentDigest
  )
    throw new Error('Actual Core does not match the qualification identity');
  // Required by the actual native bridge; an old published Core cannot become a new installer.
  const sums = await readFile(join(coreRoot, 'resources/metadata/SHA256SUMS'), 'utf8');
  const checksummedPaths = new Set(
    sums
      .trim()
      .split(/\r?\n/)
      .map((line) => line.slice(66)),
  );
  for (const name of [
    'installed-entry',
    'complete-bootstrap',
    'install-official-pack',
    'published-bootstrap',
    'resource-mirror',
    'cancel-control',
  ]) {
    if (!checksummedPaths.has(`resources/app/dist/web-installer/${name}.mjs`))
      throw new Error('Required installed bridge is absent from the verified Core inventory');
  }
  if (!checksummedPaths.has('resources/app/dist/updates/contract.js'))
    throw new Error('Core update contract is absent from its verified inventory');
  const { BOX_READ_TOKEN } = await import(
    pathToFileURL(join(coreRoot, 'resources/app/dist/updates/contract.js')).href
  );
  if (typeof BOX_READ_TOKEN !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(BOX_READ_TOKEN))
    throw new Error('Existing public Box read contract is invalid');
  const core = await identity(join(product, coreName));
  const installer = await identity(join(product, manifest.installer.name));
  if (
    core.sha256 !== release.archiveSha256 ||
    installer.sha256 !== manifest.installer.sha256 ||
    installer.bytes !== manifest.installer.bytes
  )
    throw new Error('Qualified archive or NSIS bytes changed');
  return {
    schemaVersion: 1,
    kind: 'nsis-setup',
    version: manifest.version,
    name: manifest.installer.name,
    bytes: installer.bytes,
    sha256: installer.sha256,
    gitSha: manifest.gitSha,
    contentDigest: manifest.installer.contentDigest,
    urls: [
      `https://github.com/Starfie1d1272/Mizar/releases/download/v${manifest.version}/${manifest.installer.name}`,
    ],
    coreName,
    coreBytes: core.bytes,
    coreSha256: core.sha256,
    allowExecute: true,
    publicationRequired: true,
    boxReadToken: BOX_READ_TOKEN,
  };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 5)
    throw new Error('Usage: qualification-plan.mjs PRODUCT CORE OUTPUT');
  const plan = await qualificationPlan(
    resolve(process.argv[2]),
    resolve(process.argv[3]),
    {
      repository: process.env.GITHUB_REPOSITORY,
      ref: process.env.GITHUB_REF,
      sha: process.env.GITHUB_SHA,
      event: process.env.GITHUB_EVENT_NAME,
      workflowRef: process.env.GITHUB_WORKFLOW_REF,
    },
    execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    process.env.QUALIFICATION_SOURCE_INPUT,
  );
  await mkdir(dirname(resolve(process.argv[4])), { recursive: true });
  await writeFile(process.argv[4], `${JSON.stringify(plan, null, 2)}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
}
