import { access, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function verifyWebResources(root) {
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
  await verifyWebResources(resolve(process.argv[2] ?? 'apps/web/dist'));
  console.log(
    'Production Web: EPL editor replays retained; historical development replays excluded.',
  );
}
