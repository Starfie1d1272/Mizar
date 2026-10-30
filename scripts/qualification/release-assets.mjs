import { createHash } from 'node:crypto';
import { readFile, mkdtemp, rm, access } from 'node:fs/promises';
import { join, basename, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { validateReleaseTag } from './app-version.mjs';
const repo = 'Starfie1d1272/Mizar';
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const githubApi = (args) => {
  try {
    return execFileSync('gh', ['api', ...args], {
      stdio: 'pipe',
      timeout: 180000,
      maxBuffer: 256 * 1024 * 1024,
    });
  } catch (error) {
    const status = /\(HTTP ([1-5]\d\d)\)/.exec(error.stderr?.toString() ?? '')?.[1];
    // Raw gh errors can include temporary download URLs or authorization headers.
    const safe = new Error(
      `GitHub release API failed${status ? ` (HTTP ${status})` : ''}; reconcile remote state before retry`,
    );
    if (status === '404') safe.stderr = '(HTTP 404)';
    throw safe;
  }
};
export async function publicProductAssets(product) {
  const manifest = JSON.parse(await readFile(join(product, 'release-manifest.json')));
  const paths = [manifest.archive];
  const distribution = JSON.parse(await readFile(join(product, 'distribution-manifest.json')));
  if (distribution.gitSha !== manifest.gitSha || distribution.appVersion !== manifest.appVersion)
    throw new Error('发行身份不一致');
  paths.push(distribution.archive);
  const core = JSON.parse(await readFile(join(product, 'core-release-manifest.json')));
  const coreDistribution = JSON.parse(
    await readFile(join(product, 'core-distribution-manifest.json')),
  );
  if (
    core.resourceMode !== 'core' ||
    core.gitSha !== manifest.gitSha ||
    core.appVersion !== manifest.appVersion ||
    core.derivedFrom?.archiveSha256 !== manifest.archiveSha256 ||
    coreDistribution.originalArchiveSha256 !== core.archiveSha256 ||
    coreDistribution.contentDigest !== core.contentDigest ||
    coreDistribution.gitSha !== core.gitSha ||
    coreDistribution.appVersion !== core.appVersion
  )
    throw new Error('Distinct qualified Core identity is required');
  paths.push(coreDistribution.archive);
  if (/^\d+\.\d+\.\d+$/.test(manifest.appVersion)) {
    paths.push('update-manifest.json');
    const build = JSON.parse(await readFile(join(product, 'web-installer-build.json')));
    const name = `Mizar-v${manifest.appVersion}-Windows-x64-WebInstaller.exe`;
    const bytes = await readFile(join(product, name));
    if (
      build.artifact !== name ||
      build.gitSha !== manifest.gitSha ||
      build.version !== manifest.appVersion ||
      build.sha256 !== hash(bytes) ||
      build.bytes !== bytes.length ||
      build.installer !== coreDistribution.archive ||
      build.core !== core.archive
    )
      throw new Error('轻量安装器不是同一资格候选的原字节');
    paths.push(name);
  }
  if (
    paths.some((name) => typeof name !== 'string' || name !== basename(name) || name.includes('..'))
  )
    throw new Error('发行路径无效');
  if (!/^\d+\.\d+\.\d+$/.test(manifest.appVersion)) {
    try {
      await access(join(product, 'machine-metadata.json'));
      paths.push('machine-metadata.json');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return paths.map((name) => join(product, name));
}
export async function assetInventory(paths) {
  return Promise.all(
    paths.map(async (path) => {
      const bytes = await readFile(path);
      return { path, name: basename(path), size: bytes.length, sha256: hash(bytes) };
    }),
  );
}
export function missingAssets(release, ref, identity, expected) {
  const stable = /^v\d+\.\d+\.\d+$/.test(identity.tag);
  if (
    release.tag_name !== identity.tag ||
    release.prerelease !== !stable ||
    typeof release.draft !== 'boolean' ||
    ref.object?.type !== 'commit' ||
    ref.object.sha !== identity.gitSha ||
    (!release.draft && !release.published_at)
  )
    throw new Error('发行或标签身份不一致');
  if (!expected.length || new Set(expected.map((a) => a.name)).size !== expected.length)
    throw new Error('发行资产清单重复或为空');
  return expected.filter((asset) => {
    const found = release.assets.filter((a) => a.name === asset.name);
    if (!found.length) return true;
    if (
      found.length !== 1 ||
      found[0].size !== asset.size ||
      found[0].digest !== `sha256:${asset.sha256}` ||
      found[0].browser_download_url !==
        `https://github.com/${repo}/releases/download/${identity.tag}/${asset.name}`
    )
      throw new Error(`已有同名资产不同，拒绝覆盖：${asset.name}`);
    return false;
  });
}
// Verify every existing original before adding anything; uploads never use --clobber.
export async function reconcileAssets(release, ref, identity, expected, readExisting, upload) {
  const missing = missingAssets(release, ref, identity, expected);
  for (const asset of expected.filter((a) => !missing.includes(a))) {
    const bytes = await readExisting(asset.name);
    if (bytes.length !== asset.size || hash(bytes) !== asset.sha256)
      throw new Error(`已有资产实际字节不同：${asset.name}`);
  }
  for (const asset of missing) await upload(asset.path);
  return missing;
}
// Drafts without a tag are addressed by release ID; never publish or create a tag here.
export async function stageDraftAssets(releaseId, identity, expected, api = githubApi) {
  validateReleaseTag(identity.tag, identity.tag.slice(1));
  if (
    !/^\d+$/.test(releaseId) ||
    !/^[a-f0-9]{40}$/.test(identity.gitSha) ||
    expected.length === 0 ||
    new Set(expected.map((asset) => asset.name)).size !== expected.length
  )
    throw new Error('Invalid draft identity or asset inventory');
  const ensureNoTag = () => {
    try {
      api([`repos/${repo}/git/ref/tags/${identity.tag}`]);
      throw new Error('Tag already exists; use normal reconciliation');
    } catch (error) {
      if (!error.stderr?.toString().includes('(HTTP 404)')) throw error;
    }
  };
  ensureNoTag();
  const getDraft = () => {
    const release = JSON.parse(api([`repos/${repo}/releases/${releaseId}`]).toString());
    if (
      String(release.id) !== releaseId ||
      release.draft !== true ||
      release.prerelease !== !/^v\d+\.\d+\.\d+$/.test(identity.tag) ||
      release.tag_name !== identity.tag ||
      release.target_commitish !== identity.gitSha ||
      !Array.isArray(release.assets) ||
      release.assets.some((item) => !expected.some((asset) => asset.name === item.name)) ||
      new Set(release.assets.map((item) => item.name)).size !== release.assets.length
    )
      throw new Error('Draft identity or contents differ; preserve it');
    return release;
  };
  const verify = (item, asset) => {
    if (
      item.state !== 'uploaded' ||
      item.size !== asset.size ||
      item.digest !== `sha256:${asset.sha256}` ||
      !Number.isSafeInteger(item.id)
    )
      throw new Error(`Draft asset metadata differs: ${asset.name}`);
    const bytes = api([
      '-H',
      'Accept: application/octet-stream',
      `repos/${repo}/releases/assets/${item.id}`,
    ]);
    if (bytes.length !== asset.size || hash(bytes) !== asset.sha256)
      throw new Error(`Draft asset bytes differ: ${asset.name}`);
  };
  // Check every pre-existing asset before adding any missing one.
  const initial = getDraft();
  for (const asset of expected) {
    const item = initial.assets.find((entry) => entry.name === asset.name);
    if (item) verify(item, asset);
  }
  for (const asset of expected.filter(
    (entry) => !initial.assets.some((item) => item.name === entry.name),
  )) {
    const release = getDraft();
    const item = release.assets.find((entry) => entry.name === asset.name);
    if (item) {
      verify(item, asset);
      continue;
    }
    api([
      '--method',
      'POST',
      '-H',
      'Content-Type: application/octet-stream',
      '--input',
      asset.path,
      `https://uploads.github.com/repos/${repo}/releases/${releaseId}/assets?name=${encodeURIComponent(asset.name)}`,
    ]);
    const uploaded = getDraft().assets.find((entry) => entry.name === asset.name);
    if (!uploaded) throw new Error(`Uploaded draft asset not found: ${asset.name}`);
    verify(uploaded, asset);
  }
  const final = getDraft();
  if (final.assets.length !== expected.length) throw new Error('Draft asset inventory incomplete');
  for (const asset of expected)
    verify(
      final.assets.find((item) => item.name === asset.name),
      asset,
    );
  ensureNoTag();
}

// Publish only the exact draft just fully checked; an uncertain PATCH is never replayed here.
export async function publishDraftAssets(releaseId, identity, expected, api = githubApi) {
  await stageDraftAssets(releaseId, identity, expected, api);
  const args = ['--method', 'PATCH', `repos/${repo}/releases/${releaseId}`, '-F', 'draft=false'];
  if (!/^v\d+\.\d+\.\d+$/.test(identity.tag)) args.push('-f', 'make_latest=false');
  api(args);
  const release = JSON.parse(api([`repos/${repo}/releases/tags/${identity.tag}`]).toString());
  const ref = JSON.parse(api([`repos/${repo}/git/ref/tags/${identity.tag}`]).toString());
  if (String(release.id) !== releaseId || release.draft !== false)
    throw new Error('Published release ID differs from verified draft');
  await reconcileAssets(
    release,
    ref,
    identity,
    expected,
    async (name) => {
      const items = release.assets.filter((item) => item.name === name);
      if (items.length !== 1 || !Number.isSafeInteger(items[0].id) || items[0].id <= 0)
        throw new Error('Published asset ID is invalid');
      return api([
        '-H',
        'Accept: application/octet-stream',
        `repos/${repo}/releases/assets/${items[0].id}`,
      ]);
    },
    async () => {
      throw new Error('Published release is missing a staged asset');
    },
  );
  return { release, ref };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, product, ...args] = process.argv.slice(2);
  const paths = await publicProductAssets(product);
  if (mode === 'assets') console.log(JSON.stringify(paths));
  else if (mode === 'draft-stage' || mode === 'publish-draft') {
    const [identityPath, resources, releaseId, releaseOutput, refOutput] = args;
    const { readdir } = await import('node:fs/promises');
    if (resources !== '-') {
      const archives = (await readdir(resources)).filter((name) => name.endsWith('.zip'));
      if (archives.length !== 1) throw new Error('Expected one frozen resource archive');
      paths.push(join(resources, archives[0]));
    }
    const identity = JSON.parse(await readFile(identityPath));
    const expected = await assetInventory(paths);
    if (mode === 'draft-stage') await stageDraftAssets(releaseId, identity, expected);
    else {
      if (!releaseOutput || !refOutput) throw new Error('Published readback output is required');
      const result = await publishDraftAssets(releaseId, identity, expected);
      const { writeFile } = await import('node:fs/promises');
      await writeFile(releaseOutput, JSON.stringify(result.release));
      await writeFile(refOutput, JSON.stringify(result.ref));
    }
  } else if (mode === 'reconcile') {
    const [releasePath, refPath, identityPath, resources] = args;
    if (resources && resources !== '-') {
      const { readdir } = await import('node:fs/promises');
      for (const name of await readdir(resources))
        if (name.endsWith('.zip')) paths.push(join(resources, name));
    }
    const release = JSON.parse(await readFile(releasePath)),
      ref = JSON.parse(await readFile(refPath)),
      identity = JSON.parse(await readFile(identityPath));
    const temp = await mkdtemp(join(tmpdir(), 'mizar-published-bytes-'));
    try {
      await reconcileAssets(
        release,
        ref,
        identity,
        await assetInventory(paths),
        async (name) => {
          execFileSync(
            'gh',
            ['release', 'download', identity.tag, '--repo', repo, '--pattern', name, '--dir', temp],
            { stdio: 'pipe', timeout: 180000 },
          );
          return readFile(join(temp, name));
        },
        async (path) => {
          execFileSync('gh', ['release', 'upload', identity.tag, path, '--repo', repo], {
            stdio: 'inherit',
            timeout: 180000,
          });
        },
      );
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  } else
    throw new Error(
      'release-assets assets PRODUCT | reconcile PRODUCT RELEASE REF IDENTITY RESOURCES-or-dash',
    );
}
