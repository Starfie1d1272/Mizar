import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BoxClient } from './box-sync.mjs';
import { buildMetadata } from './mulnx-bundle.mjs';

const names = ['LICENSE.txt', 'COPYRIGHT.md', 'SECURITY.md'];
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const root = process.env.MULNX_SYNC_DIR ?? '.agent-tmp/mulnx-sync';
const sourceSha = process.env.GITHUB_SHA;
// Only a previously authenticated, fully published snapshot can avoid archive transport.
async function publishedSnapshot() {
  const { readMulnxMirror } = await import(
    pathToFileURL(join(process.cwd(), 'apps/companion/dist/orchestration/tool-mirror.js')).href
  );
  try {
    return await readMulnxMirror(join(root, 'trust'));
  } catch (error) {
    console.warn('Existing MulNX snapshot unavailable; preparing full snapshot:', error.message);
    return undefined;
  }
}
const fail = (message) => {
  throw new Error(message);
};

async function prepare() {
  if (process.env.GITHUB_REF !== 'refs/heads/main' || !/^[a-f0-9]{40}$/.test(sourceSha ?? ''))
    fail('MulNX sync requires main source identity');
  await mkdir(root, { recursive: true });
  const { latestMulnxRelease, downloadVerified, upstreamNotice } = await import(
    pathToFileURL(join(process.cwd(), 'apps/companion/dist/orchestration/tool-release.js')).href
  );
  const release = await latestMulnxRelease(buildMetadata);
  const previous = await publishedSnapshot();
  const reuse = previous && JSON.stringify(previous.release) === JSON.stringify(release);
  const notices = reuse ? previous.notices : {};
  if (!reuse)
    await downloadVerified(release.url, join(root, 'MulNX.7z'), release.sha256, release.size);
  for (const name of reuse ? [] : names) {
    const bytes = await upstreamNotice(name, release.tag, buildMetadata);
    if (!bytes.length || bytes.length > 256 * 1024) fail('MulNX notice exceeds budget');
    await writeFile(join(root, name), bytes, { flag: 'wx' });
    notices[name] = { size: bytes.length, sha256: digest(bytes) };
  }
  const index = {
    schema: 'mizar.mulnx-index.v1',
    repository: 'Co1Swet/MulNX_CS2',
    sourceSha,
    checkedAt: new Date().toISOString(),
    release,
    notices,
  };
  await writeFile(join(root, 'mulnx-index.json'), JSON.stringify(index) + '\n', { flag: 'wx' });
}
async function ensureDirectory(box, path) {
  const slash = path.lastIndexOf('/');
  const parent = path.slice(0, slash) || '/';
  const name = path.slice(slash + 1);
  const matches = (await box.list(parent)).filter((entry) => entry.name === name);
  if (matches.length > 1 || (matches.length && matches[0].type !== 'dir'))
    fail('Box directory conflict');
  if (!matches.length) await box.api('dir', path, 'POST', { operation: 'mkdir' });
}
async function ensureFile(box, folder, name, bytes) {
  const matches = (await box.list(folder)).filter((entry) => entry.name === name);
  if (matches.length > 1 || (matches.length && matches[0].type !== 'file'))
    fail('Box file conflict');
  if (!matches.length) await box.upload(folder, name, bytes);
  const actual = await box.hash(`${folder}/${name}`);
  if (actual.size !== bytes.length || actual.sha256 !== digest(bytes))
    fail('Box readback mismatch');
}
async function publish() {
  const indexBytes = await readFile(join(root, 'mulnx-index.json'));
  const index = JSON.parse(indexBytes);
  if (index.sourceSha !== sourceSha || process.env.GITHUB_REF !== 'refs/heads/main')
    fail('source mismatch');
  const proof = JSON.parse(await readFile(process.env.MULNX_ATTESTATION_PATH, 'utf8'));
  const { createMizarVerifier, verifyMizarAttestation } =
    await import('../../packages/resource-pack-contract/attestation.mjs');
  const verifier = await createMizarVerifier('mulnx-sync', sourceSha);
  if (
    verifyMizarAttestation(indexBytes, 'mulnx-index.json', proof, verifier, 'mulnx-sync') !==
    sourceSha
  )
    fail('proof source mismatch');
  const box = new BoxClient(process.env.MIZAR_BOX_REPO_TOKEN);
  await box.initialize();
  const previous = await publishedSnapshot();
  await publishSnapshot(
    box,
    indexBytes,
    proof,
    (name) => readFile(join(root, name)),
    async () => {
      const { latestMulnxRelease } = await import(
        pathToFileURL(join(process.cwd(), 'apps/companion/dist/orchestration/tool-release.js')).href
      );
      return latestMulnxRelease(buildMetadata);
    },
    previous,
  );
}
export async function publishSnapshot(box, indexBytes, proof, readSource, latest, previous) {
  const index = JSON.parse(indexBytes);
  const folder = `/Tools/MulNX/${index.release.id}/${index.release.assetId}`;
  for (const dir of ['/Tools', '/Tools/MulNX', `/Tools/MulNX/${index.release.id}`, folder])
    await ensureDirectory(box, dir);
  const reuse =
    previous &&
    JSON.stringify(previous.release) === JSON.stringify(index.release) &&
    JSON.stringify(previous.notices) === JSON.stringify(index.notices);
  for (const name of reuse ? [] : ['MulNX.7z', ...names]) {
    const bytes = await readSource(name);
    const expected =
      name === 'MulNX.7z'
        ? { size: index.release.size, sha256: index.release.sha256 }
        : index.notices[name];
    if (!expected || bytes.length !== expected.size || digest(bytes) !== expected.sha256)
      fail('Local snapshot does not match signed index');
    await ensureFile(box, folder, name, bytes);
  }
  const current = await latest();
  if (JSON.stringify(current) !== JSON.stringify(index.release))
    fail('Upstream candidate changed during sync');
  const envelope = Buffer.from(
    JSON.stringify({
      schema: 'mizar.mulnx-envelope.v1',
      indexBase64: indexBytes.toString('base64'),
      proof,
    }) + '\n',
  );
  if (envelope.length > 2 * 1024 * 1024) fail('MulNX envelope exceeds budget');
  await box.upload('/Tools/MulNX', 'latest.json', envelope, true);
  const actual = await box.hash('/Tools/MulNX/latest.json');
  if (actual.size !== envelope.length || actual.sha256 !== digest(envelope))
    fail('Box pointer readback mismatch');
  console.log(
    `Verified MulNX ${index.release.id}/${index.release.assetId} sha256 ${index.release.sha256}; index sha256 ${digest(envelope)}`,
  );
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === 'prepare') await prepare();
  else if (process.argv[2] === 'publish') await publish();
  else fail('Expected prepare or publish');
}
