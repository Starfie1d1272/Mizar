import { access, readFile, readdir, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL, URL } from 'node:url';

export function webResourceMode(value = process.env.MIZAR_WEB_RESOURCE_MODE ?? 'full') {
  if (!['full', 'core-only'].includes(value))
    throw new Error(`Unknown Web resource mode: ${value}`);
  return value;
}

async function verifyCoreFiles(source, target) {
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error('Core source contains a symlink');
    if ((await lstat(resolve(target, entry.name))).isSymbolicLink()) {
      throw new Error('Core output contains a symlink');
    }
    if (entry.isDirectory())
      await verifyCoreFiles(resolve(source, entry.name), resolve(target, entry.name));
    else {
      const [original, packaged] = await Promise.all([
        readFile(resolve(source, entry.name)),
        readFile(resolve(target, entry.name)),
      ]);
      if (!original.equals(packaged))
        throw new Error(`Required Core resource differs: ${entry.name}`);
    }
  }
}

export async function verifyWebResources(root, requestedMode) {
  const mode = webResourceMode(requestedMode);
  let marker;
  let hasMarker;
  try {
    marker = JSON.parse(await readFile(resolve(root, 'web-resource-mode.json'), 'utf8'));
    hasMarker = true;
  } catch (error) {
    if (error.code !== 'ENOENT' || mode === 'core-only') throw error;
    hasMarker = false;
  }
  if (hasMarker && (!marker || marker.schemaVersion !== 1 || marker.resourceMode !== mode)) {
    throw new Error('Web resource mode does not match the requested bundle');
  }
  if (mode === 'core-only') {
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (
        !['assets', 'brand', 'index.html', 'product-shell.css', 'web-resource-mode.json'].includes(
          entry.name,
        ) ||
        entry.isSymbolicLink()
      ) {
        throw new Error(`Core contains unknown or optional resources: ${entry.name}`);
      }
    }
    await verifyCoreFiles(
      fileURLToPath(new URL('../../apps/web/public/brand/', import.meta.url)),
      resolve(root, 'brand'),
    );
    await verifyCoreFiles(
      fileURLToPath(new URL('../../packages/cs2-assets/generated/public/', import.meta.url)),
      root,
    );
    for (const path of ['index.html', 'product-shell.css']) await access(resolve(root, path));
    return;
  }
  const media = JSON.parse(
    await readFile(new URL('../../fixtures/epl-s24/media.json', import.meta.url), 'utf8'),
  );
  for (const asset of media.assets) {
    const bytes = await readFile(resolve(root, asset.path.replace('apps/web/public/', '')));
    if (createHash('sha256').update(bytes).digest('hex') !== asset.sha256)
      throw new Error(`Production EPL media differs from its source: ${asset.path}`);
  }
  for (const name of ['epl-inferno-opening', 'epl-inferno-final-round']) {
    await access(resolve(root, 'fixtures', name, 'replay', 'manifest.json'));
  }
  const videoRoot = 'fixtures/epl-inferno-video';
  const sourceRoot = new URL('../../apps/web/public/fixtures/epl-inferno-video/', import.meta.url);
  const sourceManifest = await readFile(new URL('replay/manifest.json', sourceRoot));
  const packagedManifest = await readFile(resolve(root, videoRoot, 'replay/manifest.json'));
  if (!sourceManifest.equals(packagedManifest))
    throw new Error('Production replay manifest differs from source');
  const manifest = JSON.parse(sourceManifest);
  const artifacts = {
    'frames.jsonl': manifest.framesSha256,
    'events.jsonl': manifest.eventIndexSha256,
    'match-context.json': manifest.matchContextSha256,
    'capture-manifest.json': manifest.captureManifestSha256,
    [manifest.video.file]: manifest.video.sha256,
  };
  for (const [file, expected] of Object.entries(artifacts)) {
    const bytes = await readFile(resolve(root, videoRoot, 'replay', file));
    if (createHash('sha256').update(bytes).digest('hex') !== expected)
      throw new Error(`Production video replay artifact hash mismatch: ${file}`);
  }
  const provenance = JSON.parse(await readFile(new URL('provenance.json', sourceRoot)));
  for (const avatar of provenance.avatars) {
    const bytes = await readFile(resolve(root, videoRoot, 'media', avatar));
    if (createHash('sha256').update(bytes).digest('hex') !== avatar.replace('.jpg', ''))
      throw new Error(`Production video replay avatar hash mismatch: ${avatar}`);
  }
  for (const name of ['nuke-demo-round-01', 'ancient-round-03', 'ancient-round-11-defuse']) {
    let forbidden = false;
    try {
      await access(resolve(root, 'fixtures', name));
      forbidden = true;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (forbidden) throw new Error(`Production Web contains the development-only replay: ${name}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await verifyWebResources(resolve(process.argv[2] ?? 'apps/web/dist'), process.argv[3]);
  console.log(`Production Web verified (${webResourceMode(process.argv[3])}).`);
}
