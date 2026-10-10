import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { StableSource, installerUrl } from '../updates/source.js';
import { updateJson } from '../updates/network.js';
import { downloadResourceOriginal } from './resource-mirror.mjs';
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
/** Authenticate the existing Core update chain, then both original resource directory proofs. */
export async function authenticatePublishedBootstrap(options) {
  try {
    return await authenticateBootstrapSource({ ...options, sourceMode: 'auto' });
  } catch {
    options.signal?.throwIfAborted();
    return authenticateBootstrapSource({ ...options, sourceMode: 'github' });
  }
}
async function authenticateBootstrapSource({
  version,
  tufCachePath,
  fetcher = globalThis.fetch,
  expectedCore,
  sourceMode,
  signal = new globalThis.AbortController().signal,
}) {
  signal = globalThis.AbortSignal.any([signal, globalThis.AbortSignal.timeout(600000)]);
  if (version !== undefined && !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version))
    throw new Error('Bootstrap version must be an exact Stable version');
  const source = new StableSource(tufCachePath, fetcher);
  let selected = await source.latest(signal, version);
  if (version !== undefined && selected?.tag_name !== `v${version}`) {
    selected = await updateJson(
      `https://api.github.com/repos/${repository}/releases/tags/v${version}`,
      signal,
      fetcher,
    );
  }
  if (
    !selected ||
    selected.draft !== false ||
    selected.prerelease !== false ||
    typeof selected.published_at !== 'string'
  )
    throw new Error('Bootstrap requires a published Stable release');
  const manifest = await source.authenticate(selected, signal);
  if (
    expectedCore &&
    (manifest.version !== expectedCore.version ||
      manifest.gitSha !== expectedCore.gitSha ||
      (!expectedCore.coreMode &&
        (manifest.installer.contentDigest !== expectedCore.contentDigest ||
          manifest.installer.sha256 !== expectedCore.sha256 ||
          manifest.installer.bytes !== expectedCore.bytes)))
  )
    throw new Error('Published NSIS differs from the fixed native qualification identity');
  const prefix = `https://github.com/${repository}/releases/download/v${manifest.version}/`;
  const original = {};
  for (const name of [names.descriptor, names.descriptorProof, names.catalog, names.catalogProof]) {
    const maximum = name.endsWith('provenance.json') ? 2097152 : 65536;
    original[name] = await downloadResourceOriginal({
      version: manifest.version,
      name,
      maximum,
      signal,
      fetcher,
      sourceMode,
    });
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
  if (expectedCore && identity.core.archiveSha256 !== expectedCore.coreSha256)
    throw new Error('Published Core archive differs from the fixed native qualification identity');
  // Signed descriptor/catalog bind the qualified original ZIP; the existing
  // signed update/publication envelope binds the executed NSIS. A second
  // GitHub API asset listing is not a publisher authority and is unnecessary.
  const inputs = {};
  for (const [field, name, maximum, digest] of [
    ['archiveBytes', identity.archive.name, LIMITS.archiveBytes, identity.archive.sha256],
    ['archiveBundleBytes', names.archiveProof, 2097152],
    ['statementBytes', names.publication, 65536, identity.publication.sha256],
    ['publicationBundleBytes', names.publicationProof, 2097152],
  ]) {
    if (identity.assets[name] !== prefix + name)
      throw new Error('Canonical resource origin changed');
    const bytes = await downloadResourceOriginal({
      version: manifest.version,
      name,
      maximum,
      signal,
      fetcher,
      sourceMode,
    });
    if (
      (digest && hash(bytes) !== digest) ||
      (field === 'archiveBytes' && bytes.length !== identity.archive.bytes)
    )
      throw new Error('Authenticated resource asset bytes changed');
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
