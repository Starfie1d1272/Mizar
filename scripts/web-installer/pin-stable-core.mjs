import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { StableSource, installerUrl } from '../../apps/companion/dist/updates/source.js';

// This publisher authentication is the existing updater, not a second trust root.
// Build Companion first. Never create executable pins from mirror-provided hashes.
const output = resolve(process.argv[2] ?? '.agent-tmp/web-installer/pinned-core.json');
const signal = AbortSignal.timeout(60_000);
const source = new StableSource(resolve('.agent-tmp/web-installer/tuf'));
const release = await source.latest(signal);
if (!release) throw new Error('No authenticated Stable release');
const manifest = await source.authenticate(release, signal);
const plan = {
  schemaVersion: 1,
  kind: 'nsis-setup',
  version: manifest.version,
  name: manifest.installer.name,
  bytes: manifest.installer.bytes,
  sha256: manifest.installer.sha256,
  gitSha: manifest.gitSha,
  contentDigest: manifest.installer.contentDigest,
  urls: [installerUrl(manifest)],
  allowExecute: true,
};
await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(plan, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ version: plan.version, gitSha: plan.gitSha, output }));
