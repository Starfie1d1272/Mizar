import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { verifyPayload } from './product-runtime.mjs';
import { verifyWebResources } from './verify-web-resources.mjs';
import { windowsBundleName } from './app-version.mjs';
const json = async (p) => JSON.parse(await readFile(p, 'utf8'));
async function hashFile(path) {
  const hash = createHash('sha256');
  for await (const part of createReadStream(path)) hash.update(part);
  return hash.digest('hex');
}
export async function verifyCoreCandidate(product, root, sourceSha) {
  const full = await json(join(product, 'release-manifest.json'));
  const core = await json(join(product, 'core-release-manifest.json'));
  const distribution = await json(join(product, 'core-distribution-manifest.json'));
  const name = windowsBundleName(full.appVersion) + '-Core';
  if (
    core.gitSha !== sourceSha ||
    full.gitSha !== sourceSha ||
    core.appVersion !== full.appVersion ||
    core.archive !== name + '.zip' ||
    core.developmentOnly ||
    core.resourceMode !== 'core' ||
    core.desktopBuildProfile !== 'release' ||
    core.derivedFrom?.archiveSha256 !== full.archiveSha256 ||
    core.derivedFrom?.contentDigest !== full.contentDigest ||
    core.derivedFrom?.archive !== full.archive ||
    (await hashFile(join(product, core.archive))) !== core.archiveSha256
  )
    throw new Error('Core differs from the same-run original Full qualification identity');
  const artifact = await verifyPayload(root);
  if (
    artifact.gitSha !== core.gitSha ||
    artifact.appVersion !== core.appVersion ||
    artifact.resourceMode !== 'core' ||
    artifact.artifactSha256 !== core.contentDigest ||
    artifact.desktopBuildProfile !== 'release' ||
    JSON.stringify(artifact.derivedFrom) !== JSON.stringify(core.derivedFrom)
  )
    throw new Error('Core payload differs from its distinct manifest');
  await verifyWebResources(join(root, 'resources/web/dist'), 'core');
  const version = execFileSync(join(root, 'Mizar.exe'), ['--app-version'], {
    encoding: 'utf8',
    windowsHide: true,
  }).trim();
  if (
    version !== core.appVersion ||
    distribution.archive !== name + '-Setup.exe' ||
    distribution.gitSha !== core.gitSha ||
    distribution.appVersion !== core.appVersion ||
    distribution.format !== 'nsis-setup' ||
    distribution.originalArchiveSha256 !== core.archiveSha256 ||
    distribution.contentDigest !== core.contentDigest ||
    (await hashFile(join(product, distribution.archive))) !== distribution.archiveSha256 ||
    (await stat(join(product, distribution.archive))).size !== distribution.archiveBytes
  )
    throw new Error('Core executable or NSIS differs from its distinct qualification identity');
  return core;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const product = resolve(process.argv[2]);
  const core = await verifyCoreCandidate(product, resolve(process.argv[3]), process.argv[4]);
  if (process.argv[5])
    await writeFile(
      resolve(process.argv[5]),
      JSON.stringify({
        ...core,
        distribution: await json(join(product, 'core-distribution-manifest.json')),
      }),
    );
}
