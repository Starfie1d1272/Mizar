import { readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateReleaseTag } from './app-version.mjs';

export const repository = 'Starfie1d1272/Mizar';
const requireValue = (ok, message) => { if (!ok) throw new Error(message); };
export function technicalTag(version) {
  validateReleaseTag(`v${version}`, version);
  return `data-v${version}`;
}
export function technicalPrefix(version) {
  return `https://github.com/${repository}/releases/download/${technicalTag(version)}/`;
}
const compare = (a, b) => {
  const x = a.split('.').map(Number), y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
};
export function makeReleaseLayout(manifest, policy) {
  technicalTag(manifest.appVersion);
  requireValue(/^[a-f0-9]{40}$/.test(manifest.gitSha), '发行布局源码无效');
  const legacyMainAssets = policy.legacyMainAssets !== false;
  if (!legacyMainAssets) {
    // Removing an old fixed location is a deliberate support-policy change,
    // only after a published bridge version supports the technical location.
    const first = policy.technicalClientMinimumVersion;
    requireValue(
      /^\d+\.\d+\.\d+$/.test(first ?? '') &&
      /^\d+\.\d+\.\d+$/.test(policy.minimumVersion ?? '') &&
      compare(first, '1.1.0') > 0 && compare(policy.minimumVersion, first) >= 0 &&
      compare(manifest.appVersion.replace(/-rc\.\d+$/, ''), first) >= 0,
      '删除兼容附件前必须声明桥接版本，并将最低支持版本提高到桥接版本',
    );
  }
  return {
    schemaVersion: 'mizar.release-layout.v1',
    appVersion: manifest.appVersion,
    gitSha: manifest.gitSha,
    technicalTag: technicalTag(manifest.appVersion),
    legacyMainAssets,
  };
}
export function assertTechnicalRelease(release, manifest, allowDraft = false) {
  requireValue(
    release?.tag_name === technicalTag(manifest.appVersion) &&
    release.prerelease === true &&
    (allowDraft || (release.draft === false && release.published_at)),
    '技术发行必须是同版本的受控预发布；不能作为 Stable 产品发行',
  );
}
export async function readReleaseLayout(product) {
  const manifest = JSON.parse(await readFile(join(product, 'release-manifest.json')));
  const layout = JSON.parse(await readFile(join(product, 'release-layout.json')));
  requireValue(
    layout.schemaVersion === 'mizar.release-layout.v1' &&
    layout.appVersion === manifest.appVersion && layout.gitSha === manifest.gitSha &&
    layout.technicalTag === technicalTag(manifest.appVersion) &&
    typeof layout.legacyMainAssets === 'boolean' &&
    Object.keys(layout).length === 5,
    '发行布局与资格 Core 不一致',
  );
  return layout;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, product] = process.argv.slice(2);
  if (mode !== 'prepare' || !product) throw new Error('release-layout prepare PRODUCT');
  const manifest = JSON.parse(await readFile(join(product, 'release-manifest.json')));
  const policy = JSON.parse(await readFile(new URL('./update-release.json', import.meta.url)));
  await writeFile(join(product, 'release-layout.json'), JSON.stringify(makeReleaseLayout(manifest, policy), null, 2) + '\n', { flag: 'wx' });
}
