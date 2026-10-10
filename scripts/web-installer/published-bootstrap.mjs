import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { StableSource, installerUrl } from '../updates/source.js';
import { updateJson, updateRequest, boundedBytes } from '../updates/network.js';
import { createActivePolicyVerifier } from '../resource-store/runtime-adapter.js';
import { PACK_ID, LIMITS } from '@mizar/resource-pack-contract';
import {
  RESOURCE_ASSET_NAMES as resourceNames,
  getResourceAuthorization,
  verifyResourceCatalogBytes,
  verifyResourceCatalogReceipt,
} from '@mizar/resource-pack-contract/runtime';

const repository = 'Starfie1d1272/Mizar';
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const names = {
  ...resourceNames,
  descriptorProof: resourceNames.descriptorQualification,
  catalogProof: resourceNames.catalogPromotion,
  publicationProof: resourceNames.publicationPromotion,
  archiveProof: resourceNames.archiveQualification,
};
async function download(url, maximum, signal) {
  const attempt = globalThis.AbortSignal.any([
    signal,
    globalThis.AbortSignal.timeout(maximum > 2097152 ? 300000 : 60000),
  ]);
  return boundedBytes(await updateRequest(url, attempt), maximum);
}
function asset(release, name, url, maximum, digest, expectedBytes) {
  const found = release.assets?.filter((item) => item.name === name);
  if (
    !found ||
    found.length !== 1 ||
    found[0].browser_download_url !== url ||
    !Number.isSafeInteger(found[0].size) ||
    found[0].size < 1 ||
    found[0].size > maximum ||
    (expectedBytes !== undefined && found[0].size !== expectedBytes) ||
    !/^sha256:[a-f0-9]{64}$/.test(found[0].digest) ||
    (digest && found[0].digest !== `sha256:${digest}`)
  )
    throw new Error('Published bootstrap asset identity is missing or inconsistent');
  return found[0];
}
/** Authenticate the existing Core update chain, then both original resource directory proofs. */
export async function authenticatePublishedBootstrap({
  version,
  tufCachePath,
  signal = new globalThis.AbortController().signal,
}) {
  signal = globalThis.AbortSignal.any([signal, globalThis.AbortSignal.timeout(600000)]);
  if (version !== undefined && !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version))
    throw new Error('Bootstrap version must be an exact Stable version');
  const source = new StableSource(tufCachePath);
  const selected = version
    ? await updateJson(
        `https://api.github.com/repos/${repository}/releases/tags/v${version}`,
        signal,
      )
    : await source.latest(signal);
  if (
    !selected ||
    selected.draft !== false ||
    selected.prerelease !== false ||
    typeof selected.published_at !== 'string'
  )
    throw new Error('Bootstrap requires a published Stable release');
  const manifest = await source.authenticate(selected, signal);
  const release = await updateJson(
    `https://api.github.com/repos/${repository}/releases/tags/v${manifest.version}`,
    signal,
  );
  if (
    release.tag_name !== `v${manifest.version}` ||
    release.draft !== false ||
    release.prerelease !== false ||
    typeof release.published_at !== 'string'
  )
    throw new Error('Bootstrap release identity changed');
  const prefix = `https://github.com/${repository}/releases/download/v${manifest.version}/`;
  const original = {};
  for (const name of [names.descriptor, names.descriptorProof, names.catalog, names.catalogProof]) {
    const maximum = name.endsWith('provenance.json') ? 2097152 : 65536;
    const metadata = asset(release, name, prefix + name, maximum);
    const bytes = await download(prefix + name, maximum, signal);
    if (bytes.length !== metadata.size || hash(bytes) !== metadata.digest.slice(7))
      throw new Error('Original resource directory bytes changed');
    original[name] = bytes;
  }
  const authorization = await verifyResourceCatalogBytes({
    descriptorBytes: original[names.descriptor],
    descriptorBundleBytes: original[names.descriptorProof],
    catalogBytes: original[names.catalog],
    catalogBundleBytes: original[names.catalogProof],
    expectedCore: { appVersion: manifest.version, gitSha: manifest.gitSha },
    tufCachePath,
    signal,
  });
  const identity = getResourceAuthorization(authorization);
  // The original qualified Core ZIP hash remains bound even though installation uses NSIS.
  asset(
    release,
    identity.core.archive,
    prefix + identity.core.archive,
    536870912,
    identity.core.archiveSha256,
  );
  asset(
    release,
    manifest.installer.name,
    installerUrl(manifest),
    536870912,
    manifest.installer.sha256,
    manifest.installer.bytes,
  );
  const inputs = {};
  for (const [field, name, maximum, digest] of [
    ['archiveBytes', identity.archive.name, LIMITS.archiveBytes, identity.archive.sha256],
    ['archiveBundleBytes', names.archiveProof, 2097152],
    ['statementBytes', names.publication, 65536, identity.publication.sha256],
    ['publicationBundleBytes', names.publicationProof, 2097152],
  ]) {
    const url = identity.assets[name];
    const metadata = asset(
      release,
      name,
      url,
      maximum,
      digest,
      field === 'archiveBytes' ? identity.archive.bytes : undefined,
    );
    const bytes = await download(url, maximum, signal);
    if (bytes.length !== metadata.size || hash(bytes) !== metadata.digest.slice(7))
      throw new Error('Published resource asset bytes changed');
    inputs[field] = Buffer.from(bytes);
  }
  return {
    corePlan: Object.freeze({
      version: manifest.version,
      gitSha: manifest.gitSha,
      contentDigest: manifest.installer.contentDigest,
      name: manifest.installer.name,
      bytes: manifest.installer.bytes,
      sha256: manifest.installer.sha256,
      url: installerUrl(manifest),
    }),
    authorization,
    inputs,
  };
}
/** Read dual-proof policy from the unique Store's receipt without any network or extra cache. */
export async function restoreResourceAuthorization({ store, expectedCore, signal }) {
  let authorization;
  const active = await store.reuseActive(
    PACK_ID,
    async ({ receipt, signal: storeSignal }) => {
      authorization = await verifyResourceCatalogReceipt({
        receipt: receipt.catalog,
        expectedCore,
        purpose: 'cache',
        signal: storeSignal,
      });
      return createActivePolicyVerifier(getResourceAuthorization(authorization).policy)({
        receipt,
        signal: storeSignal,
      });
    },
    { signal },
  );
  if (!active) throw new Error('Authenticated official resource cache is unavailable');
  return authorization;
}
