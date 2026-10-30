import { Buffer } from 'node:buffer';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MACHINE_METADATA_NAME,
  readMachineMetadata,
} from '../../packages/resource-pack-contract/transport.mjs';
import {
  RESOURCE_ASSET_NAMES,
  parseResourceCatalogBytes,
} from '../../packages/resource-pack-contract/catalog.mjs';
import { requireValue } from '../../packages/resource-pack-contract/index.mjs';
import { resourceAssetInventory } from '../ci/resource-release.mjs';
import { verifyReleaseAttestations } from './release-identity.mjs';
import { multipartUpload } from './box-upload.mjs';
import { curlMultipartUpload } from './box-curl-upload.mjs';
import {
  BoxClient,
  boxStage,
  MirrorError,
  getBoxRecoveryStartedAt,
  older,
  digest,
  downloadReleaseAsset,
  publishStablePointer,
  verifyStablePointer,
  verifyStableReadbacks,
  releaseIdentity,
  readReleaseInfo,
  resolveBoxTag,
  syncResourceFiles,
  syncRuntimeFiles,
  syncUserDownloads,
  verifiedUpdateIndex,
  verifyPublicDownloads,
  verifyRemote,
} from './box-sync.mjs';
import {
  assertBoxReceipt,
  createBoxPlan,
  makeBoxReceipt,
  readBoxPlan,
} from './box-phase-contract.mjs';

const identityOf = ({ name, size, sha256 }) => ({ name, size, sha256 });
const assetBytes = (name, bytes) => ({ name, size: bytes.length, sha256: digest(bytes) });
const envAttempt = () => Number(process.env.GITHUB_RUN_ATTEMPT);
const lanePath = (root, lane, name) => join(root, 'payload', lane, name);
const writeNew = async (path, bytes) => writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
const boxClient = () =>
  new BoxClient(
    process.env.MIZAR_BOX_REPO_TOKEN,
    process.env.BOX_UPLOAD_TRANSPORT === 'native' ? multipartUpload : curlMultipartUpload,
  );
const proof = async (file, sha, bundle, workflow) =>
  boxStage(
    `来源证明/${basename(file)}`,
    async () => {
      try {
        await verifyReleaseAttestations([{ file, sourceSha: sha, bundle, workflow }]);
      } catch (error) {
        // The shared verifier has already removed tokens and signed URL queries.
        throw new MirrorError(error.message);
      }
    },
    60000,
  );

function assertBytes(bytes, expected) {
  requireValue(
    bytes.length === expected.size && digest(bytes) === expected.sha256,
    `资产原字节不一致：${expected.name}`,
  );
}
async function readContext(root) {
  const bytes = await readFile(join(root, 'plan.json'));
  const plan = readBoxPlan(bytes);
  requireValue(
    plan.runId === process.env.GITHUB_RUN_ID &&
      plan.attempt <= envAttempt() &&
      digest(bytes) === process.env.BOX_PLAN_SHA256,
    '阶段计划与本次运行不一致',
  );
  const carrier = await readFile(join(root, MACHINE_METADATA_NAME));
  const carrierIdentity = plan.assets.runtime.find((asset) => asset.name === MACHINE_METADATA_NAME);
  requireValue(carrierIdentity, '阶段计划缺少机器元数据');
  assertBytes(carrier, carrierIdentity);
  const originals = readMachineMetadata(carrier);
  const core = JSON.parse(originals.get('core-release-manifest.json'));
  requireValue(
    core.appVersion === plan.tag.slice(1) &&
      core.gitSha === plan.sourceSha &&
      core.archiveSha256 === plan.coreArchiveSha,
    'Core 与已认证计划不一致',
  );
  const release = JSON.parse(await readFile(join(root, 'release.json')));
  requireValue(
    release.id === plan.releaseId &&
      release.tag_name === plan.tag &&
      !release.draft &&
      !release.prerelease &&
      release.published_at,
    'Release 与已认证计划不一致',
  );
  return { bytes, plan, carrier, originals, core, release };
}
async function verifyResourceMetadata(identity) {
  const originals = identity.originals;
  requireValue(originals, '资源阶段缺少机器元数据');
  const parsed = parseResourceCatalogBytes(
    originals.get(RESOURCE_ASSET_NAMES.descriptor),
    originals.get(RESOURCE_ASSET_NAMES.catalog),
    identity.core,
  );
  const directory = await mkdtemp(join(tmpdir(), 'mizar-box-small-proofs-'));
  try {
    for (const name of Object.values(RESOURCE_ASSET_NAMES))
      await writeNew(join(directory, name), originals.get(name));
    await proof(
      join(directory, RESOURCE_ASSET_NAMES.descriptor),
      identity.gitSha,
      join(directory, RESOURCE_ASSET_NAMES.descriptorQualification),
    );
    await proof(
      join(directory, RESOURCE_ASSET_NAMES.catalog),
      parsed.catalog.promotionSha,
      join(directory, RESOURCE_ASSET_NAMES.catalogPromotion),
      'promotion',
    );
    requireValue(
      digest(originals.get(RESOURCE_ASSET_NAMES.publication)) === parsed.entry.publication.sha256,
      '资源声明与签发目录不一致',
    );
    await proof(
      join(directory, RESOURCE_ASSET_NAMES.publication),
      parsed.entry.policy.promotionSha,
      join(directory, RESOURCE_ASSET_NAMES.publicationPromotion),
      'promotion',
    );
    return parsed;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
export async function readRelease(path) {
  const tag = await resolveBoxTag();
  const prerelease = /^v\d+\.\d+\.\d+-(?:alpha|beta|rc)\.[1-9]\d*$/.test(tag ?? '');
  if (prerelease) return { prerelease: true };
  const info = await readReleaseInfo(tag);
  await writeNew(path, Buffer.from(JSON.stringify(info)));
  return { prerelease: false, tag };
}
export async function prepare(
  root,
  infoPath,
  {
    loadIdentity = releaseIdentity,
    loadIndex = verifiedUpdateIndex,
    verifyResources = verifyResourceMetadata,
  } = {},
) {
  const info = JSON.parse(await readFile(infoPath));
  const { tag } = info;
  const identity = await loadIdentity(tag, {
    runtime: false,
    bootstrap: false,
    releaseInfo: info,
  });
  requireValue(
    identity.runtime?.length === 2 &&
      identity.bootstrap &&
      identity.core &&
      identity.originals &&
      !older(identity.version, '1.6.0'),
    '仅同步已签拆分发行',
  );
  const index = await loadIndex(identity, tag);
  const resources = await verifyResources(identity);
  const archive = resources.entry.archive;
  const matching = identity.release.assets.filter((asset) => asset.name === archive.name);
  requireValue(
    matching.length === 1 &&
      matching[0].size === archive.bytes &&
      matching[0].digest === `sha256:${archive.sha256}` &&
      matching[0].browser_download_url ===
        `https://github.com/Starfie1d1272/Mizar/releases/download/${tag}/${archive.name}`,
    '资源归档与公开 Release 不一致',
  );
  const planBytes = createBoxPlan({
    runId: process.env.GITHUB_RUN_ID,
    attempt: envAttempt(),
    tag,
    releaseId: identity.release.id,
    sourceSha: identity.gitSha,
    coreArchiveSha: identity.core.archiveSha256,
    assets: {
      runtime: identity.runtime.map(identityOf),
      resources: [{ name: archive.name, size: archive.bytes, sha256: archive.sha256 }],
      downloads: [identityOf(identity.bootstrap)],
    },
    updateIndex: assetBytes('update-index.json', index),
  });
  await mkdir(root, { recursive: true });
  await writeNew(join(root, 'plan.json'), planBytes);
  await writeNew(
    join(root, MACHINE_METADATA_NAME),
    identity.runtime.find((asset) => asset.name === MACHINE_METADATA_NAME).bytes,
  );
  await writeNew(join(root, 'update-index.json'), index);
  await writeNew(join(root, 'release.json'), Buffer.from(JSON.stringify(identity.release)));
  return { prerelease: false, planSha256: digest(planBytes), tag };
}
export async function downloadLane(
  root,
  lane,
  { download = downloadReleaseAsset, verify = proof, inventory = resourceAssetInventory } = {},
) {
  const { plan, release, carrier, originals, core } = await readContext(root);
  requireValue(['runtime', 'resources', 'downloads'].includes(lane), '未知分发通道');
  const output = join(root, 'payload', lane);
  await mkdir(output, { recursive: true });
  for (const expected of plan.assets[lane]) {
    const bytes =
      expected.name === MACHINE_METADATA_NAME
        ? carrier
        : await download(release, plan.tag, expected.name, expected.size);
    assertBytes(bytes, expected);
    await writeNew(join(output, expected.name), bytes);
    if (lane !== 'resources' && expected.name !== MACHINE_METADATA_NAME)
      await verify(join(output, expected.name), plan.sourceSha);
  }
  if (lane === 'resources') {
    const temp = await mkdtemp(join(tmpdir(), 'mizar-box-resource-'));
    try {
      for (const name of Object.values(RESOURCE_ASSET_NAMES))
        await writeNew(join(temp, name), originals.get(name));
      const expected = plan.assets.resources[0];
      await writeNew(
        join(temp, expected.name),
        await readFile(lanePath(root, lane, expected.name)),
      );
      const verifiedInventory = await inventory(temp, core, true);
      requireValue(
        verifiedInventory.some(
          (asset) =>
            asset.name === expected.name &&
            asset.size === expected.size &&
            asset.sha256 === expected.sha256,
        ),
        '资源归档来源核验与计划不一致',
      );
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  }
}
async function laneFiles(root, plan, lane) {
  return Promise.all(
    plan.assets[lane].map(async (expected) => {
      const bytes = await readFile(lanePath(root, lane, expected.name));
      assertBytes(bytes, expected);
      return { ...expected, bytes };
    }),
  );
}
const bootstrapIdentity = (plan) => ({
  ...plan.assets.downloads[0],
  version: plan.tag.slice(1),
  gitSha: plan.sourceSha,
  releaseId: plan.releaseId,
});
export async function transferLane(root, lane, selected, box = boxClient()) {
  const { plan, originals } = await readContext(root);
  const files = await laneFiles(root, plan, lane);
  await box.initialize();
  if (lane === 'runtime') {
    requireValue(['metadata', 'core'].includes(selected), 'Runtime 资产选择无效');
    const name =
      selected === 'metadata'
        ? MACHINE_METADATA_NAME
        : `Mizar-${plan.tag}-Windows-x64-Core-Setup.exe`;
    return syncRuntimeFiles({ box, version: plan.tag.slice(1), files, selected: name });
  }
  if (lane === 'resources') {
    const catalog = JSON.parse(originals.get(RESOURCE_ASSET_NAMES.catalog));
    const reuseVersion = catalog.origin?.publication?.releaseVersion;
    return syncResourceFiles({
      box,
      version: plan.tag.slice(1),
      files,
      metadataInRuntime: true,
      reuseVersion:
        reuseVersion && older(reuseVersion, plan.tag.slice(1)) ? reuseVersion : undefined,
    });
  }
  requireValue(lane === 'downloads', '未知分发通道');
  const identity = bootstrapIdentity(plan);
  return syncUserDownloads({
    box,
    bootstrap: {
      identity,
      bytes: files[0].bytes,
      resolveIdentity: async (tag) => (await releaseIdentity(tag, { runtime: false })).bootstrap,
    },
    resolveIdentity: (tag) => releaseIdentity(tag, { runtime: false }),
    accept: async () => {},
  });
}
const remotePath = (plan, lane, name) =>
  lane === 'runtime'
    ? `/Runtime/${plan.tag}/${name}`
    : lane === 'resources'
      ? `/Resources/${plan.tag}/${name}`
      : `/Stable/Downloads/${name}`;
export async function verifyLane(
  root,
  lane,
  box = boxClient(),
  publicVerify = verifyPublicDownloads,
) {
  const { bytes, plan } = await readContext(root);
  requireValue(['runtime', 'resources', 'downloads'].includes(lane), '未知分发通道');
  await box.initialize();
  for (const asset of plan.assets[lane])
    await verifyRemote(box, remotePath(plan, lane, asset.name), asset);
  if (lane === 'downloads')
    await publicVerify({ bootstrap: { identity: bootstrapIdentity(plan) } });
  const receipt = makeBoxReceipt(
    bytes,
    lane,
    process.env.GITHUB_RUN_ID,
    envAttempt(),
    plan.assets[lane],
  );
  await mkdir(join(root, 'receipt'), { recursive: true });
  await writeNew(join(root, 'receipt', `${lane}.json`), receipt);
}
async function finalContext(root, receipts) {
  const { bytes, plan } = await readContext(root);
  for (const lane of ['runtime', 'resources', 'downloads'])
    assertBoxReceipt(
      bytes,
      await readFile(join(receipts, `${lane}.json`)),
      lane,
      process.env.GITHUB_RUN_ID,
      envAttempt(),
    );
  const index = await readFile(join(root, 'update-index.json'));
  assertBytes(index, plan.updateIndex);
  return { bytes, plan, index, bootstrap: { identity: bootstrapIdentity(plan) } };
}
export async function finalCheck(
  root,
  receipts,
  box = boxClient(),
  publicVerify = verifyPublicDownloads,
) {
  const { bytes, plan, bootstrap } = await finalContext(root, receipts);
  await box.initialize();
  await publicVerify({ bootstrap });
  await verifyStableReadbacks({
    box,
    identity: { version: plan.tag.slice(1) },
    bootstrap,
    runtime: plan.assets.runtime,
    resources: plan.assets.resources,
  });
  await writeNew(
    join(root, 'final-verified.json'),
    Buffer.from(
      JSON.stringify({ runId: plan.runId, attempt: envAttempt(), planSha256: digest(bytes) }),
    ),
  );
}
async function requireFinalCheck(root, receipts) {
  const context = await finalContext(root, receipts);
  const marker = JSON.parse(await readFile(join(root, 'final-verified.json')));
  requireValue(
    Object.keys(marker).sort().join(',') === 'attempt,planSha256,runId' &&
      marker.runId === context.plan.runId &&
      marker.attempt === envAttempt() &&
      marker.planSha256 === digest(context.bytes),
    '发布前完整回读记录不一致',
  );
  return context;
}
export async function updatePointer(root, receipts, box = boxClient()) {
  const { index } = await requireFinalCheck(root, receipts);
  await box.initialize();
  return publishStablePointer({ box, updateIndex: index });
}
export async function verifyPointer(root, receipts, box = boxClient()) {
  const { index } = await requireFinalCheck(root, receipts);
  await box.initialize();
  await verifyStablePointer({ box, updateIndex: index });
}
export async function verifyEntry(root, receipts, publicVerify = verifyPublicDownloads) {
  const { bootstrap } = await requireFinalCheck(root, receipts);
  await publicVerify({ bootstrap });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [phase, root, argument, selected] = process.argv.slice(2);
  try {
    if (phase === 'read-release') {
      const result = await readRelease(root);
      if (process.env.GITHUB_OUTPUT) {
        const { appendFile } = await import('node:fs/promises');
        await appendFile(
          process.env.GITHUB_OUTPUT,
          `prerelease=${result.prerelease}\nsync=${!result.prerelease}\n`,
        );
      }
    } else if (phase === 'prepare') {
      const result = await prepare(root, argument);
      if (process.env.GITHUB_OUTPUT) {
        const { appendFile } = await import('node:fs/promises');
        await appendFile(
          process.env.GITHUB_OUTPUT,
          `prerelease=${result.prerelease}\nsync=${!result.prerelease}\n${result.planSha256 ? `plan_sha256=${result.planSha256}\n` : ''}`,
        );
      }
    } else if (phase === 'download') await downloadLane(root, argument);
    else if (phase === 'transfer') await transferLane(root, argument, selected);
    else if (phase === 'verify') await verifyLane(root, argument);
    else if (phase === 'final-check') await finalCheck(root, argument);
    else if (phase === 'index-update') console.log(await updatePointer(root, argument));
    else if (phase === 'index-verify') await verifyPointer(root, argument);
    else if (phase === 'anonymous') await verifyEntry(root, argument);
    else throw new Error('未知 Box 阶段');
  } catch (error) {
    // Errors from gh or HTTP can contain credentials and temporary URLs.
    console.error(`Box 阶段 ${phase} 失败；保留现有文件并核对该阶段。`);
    if (error instanceof MirrorError) console.error(error.message);
    process.exitCode = 1;
  } finally {
    const recovery = getBoxRecoveryStartedAt();
    if (process.env.GITHUB_OUTPUT && recovery) {
      const { appendFile } = await import('node:fs/promises');
      await appendFile(process.env.GITHUB_OUTPUT, `recovery_started_at=${recovery}\n`);
    }
  }
}
