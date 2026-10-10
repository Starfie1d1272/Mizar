import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { contentDigest, writeShaSums, createArchive, sha256File } from './build.mjs';
import { verifyPayload } from './product-runtime.mjs';
import { verifyWebResources } from './verify-web-resources.mjs';
import { assertQualificationIdentity } from './release-identity.mjs';
import { windowsBundleName } from './app-version.mjs';

async function treeBytes(root) {
  let total = 0;
  for (const file of await readdir(root, { withFileTypes: true })) {
    if (file.isSymbolicLink()) throw new Error('Core source contains a symlink');
    const path = join(root, file.name);
    total += file.isDirectory() ? await treeBytes(path) : (await stat(path)).size;
  }
  return total;
}
/** Partition an unsigned same-run Full candidate; never modify qualified original assets. */
export async function prepareCoreCandidate(product, context, checkedOutSha, requestedSha) {
  const full = JSON.parse(await readFile(join(product, 'release-manifest.json'), 'utf8'));
  assertQualificationIdentity(context, checkedOutSha, requestedSha, full.gitSha);
  if (
    process.platform !== 'win32' ||
    full.resourceMode !== 'full' ||
    full.developmentOnly ||
    full.desktopBuildProfile !== 'release'
  )
    throw new Error('Core requires the exact Windows release-profile Full candidate');
  const name = windowsBundleName(full.appVersion);
  if (full.archive !== name + '.zip') throw new Error('Invalid original Full identity');
  if ((await sha256File(join(product, full.archive))) !== full.archiveSha256)
    throw new Error('Original Full archive has changed');
  const original = join(product, name);
  const artifact = await verifyPayload(original);
  if (
    artifact.artifactSha256 !== full.contentDigest ||
    artifact.gitSha !== full.gitSha ||
    artifact.appVersion !== full.appVersion ||
    artifact.resourceMode !== 'full'
  )
    throw new Error('Original Full payload differs from its candidate manifest');
  await verifyWebResources(join(original, 'resources/web/dist'), 'full');
  // The output is a new identity, not a rewrite of the original archive or metadata.
  const coreName = name + '-Core';
  const core = join(product, coreName);
  await mkdir(core, { recursive: false });
  await cp(original, core, { recursive: true, force: false, errorOnExist: true });
  const web = join(core, 'resources/web/dist');
  for (const directory of ['fixtures', 'fixture-media'])
    await rm(join(web, directory), { recursive: true, force: true });
  await writeFile(
    join(web, 'web-resource-mode.json'),
    JSON.stringify({ schemaVersion: 1, resourceMode: 'core' }) + '\n',
  );
  await verifyWebResources(web, 'core');
  const digest = await contentDigest(core);
  const derivedFrom = {
    archive: full.archive,
    archiveSha256: full.archiveSha256,
    contentDigest: full.contentDigest,
  };
  const metadata = {
    ...artifact,
    resourceMode: 'core',
    webBytes: await treeBytes(web),
    artifactSha256: digest,
    derivedFrom,
  };
  await writeFile(
    join(core, 'resources/metadata/artifact.json'),
    JSON.stringify(metadata, null, 2) + '\n',
  );
  await writeShaSums(core);
  await verifyPayload(core);
  const archive = await createArchive(core, product, coreName);
  await writeFile(
    archive.archivePath + '.sha256',
    archive.archiveSha256 + '  ' + coreName + '.zip\n',
  );
  const manifest = {
    ...full,
    resourceMode: 'core',
    webBytes: metadata.webBytes,
    archive: coreName + '.zip',
    archiveSha256: archive.archiveSha256,
    contentDigest: digest,
    derivedFrom,
  };
  await writeFile(
    join(product, 'core-release-manifest.json'),
    JSON.stringify(manifest, null, 2) + '\n',
    { flag: 'wx' },
  );
  return manifest;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const context = {
    repository: process.env.GITHUB_REPOSITORY,
    ref: process.env.GITHUB_REF,
    sha: process.env.GITHUB_SHA,
    event: process.env.GITHUB_EVENT_NAME,
    workflowRef: process.env.GITHUB_WORKFLOW_REF,
  };
  const checkedOutSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  console.log(
    JSON.stringify(
      await prepareCoreCandidate(
        resolve(process.argv[2]),
        context,
        checkedOutSha,
        process.env.QUALIFICATION_SOURCE_INPUT,
      ),
    ),
  );
}
