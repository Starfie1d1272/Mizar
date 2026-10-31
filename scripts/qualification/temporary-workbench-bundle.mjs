import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { contentDigest, writeShaSums } from './build.mjs';
import { verifyPayload } from './product-runtime.mjs';

const [directory, executable, head] = process.argv.slice(2);
if (!directory || !executable || !/^[a-f0-9]{40}$/.test(head ?? ''))
  throw new Error('Invalid temporary bundle input');
const root = resolve(directory);
if (
  execFileSync(executable, ['--app-version'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 20000,
  }).trim() !== '1.10.2'
)
  throw new Error('Temporary executable version differs');
const original = await verifyPayload(root);
if (
  original.appVersion !== '1.10.2' ||
  original.gitSha !== '77dddfa61fac235fc9da82eab03437c7ad501b99' ||
  original.resourceMode !== 'full' ||
  original.desktopBuildProfile !== 'release'
)
  throw new Error('Original product identity differs');
await copyFile(executable, join(root, 'Mizar.exe'));
const path = join(root, 'resources/metadata/artifact.json');
const metadata = JSON.parse(await readFile(path, 'utf8'));
metadata.gitSha = head;
metadata.desktopBuildProfile = 'ci';
metadata.artifactSha256 = await contentDigest(root);
await writeFile(path, JSON.stringify(metadata, null, 2) + '\n');
await writeShaSums(root);
const checked = await verifyPayload(root);
if (checked.gitSha !== head || checked.artifactSha256 !== metadata.artifactSha256)
  throw new Error('Temporary product validation failed');
console.log(
  JSON.stringify({
    version: checked.appVersion,
    head,
    profile: 'ci',
    digest: checked.artifactSha256,
  }),
);
