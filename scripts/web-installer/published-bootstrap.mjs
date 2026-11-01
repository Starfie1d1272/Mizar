import { StableSource, installerUrl } from '../updates/source.js';
import { updateJson } from '../updates/network.js';
import { logBootstrapFallback } from './resource-mirror.mjs';
import { authenticatePublishedResource } from '../distribution/resources.js';
import { createActivePolicyVerifier } from '../resource-store/runtime-adapter.js';
import { PACK_ID } from '@mizar/resource-pack-contract';
import {
  getResourceAuthorization,
  verifyResourceCatalogReceipt,
} from '@mizar/resource-pack-contract/runtime';

const repository = 'Starfie1d1272/Mizar';
/** Authenticate the existing Core update chain, then both original resource directory proofs. */
export async function authenticatePublishedBootstrap(options) {
  const signal = globalThis.AbortSignal.any([
    options.signal ?? new globalThis.AbortController().signal,
    globalThis.AbortSignal.timeout(600000),
  ]);
  let manifest;
  let sourceMode = 'auto';
  try {
    manifest = await authenticateBootstrapSource({ ...options, signal, sourceMode });
  } catch (mirrorError) {
    logBootstrapFallback('bootstrap authentication fallback', mirrorError);
    signal.throwIfAborted();
    sourceMode = 'github';
    try {
      manifest = await authenticateBootstrapSource({ ...options, signal, sourceMode });
    } catch (githubError) {
      throw new AggregateError([mirrorError, githubError], 'Bootstrap core authentication failed', {
        cause: githubError,
      });
    }
  }
  const { authorization, loadVerified } = await authenticatePublishedResource(
    {
      core: { appVersion: manifest.version, gitSha: manifest.gitSha },
      tufCachePath: options.tufCachePath,
      signal,
      fetcher: options.fetcher,
    },
    sourceMode,
  );
  const identity = getResourceAuthorization(authorization);
  if (options.expectedCore && identity.core.archiveSha256 !== options.expectedCore.coreSha256)
    throw new Error('Published Core archive differs from the fixed native qualification identity');
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
    loadVerified,
  };
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
  const source = new StableSource(tufCachePath, fetcher, sourceMode);
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
      manifest.installer.contentDigest !== expectedCore.contentDigest ||
      manifest.installer.sha256 !== expectedCore.sha256 ||
      manifest.installer.bytes !== expectedCore.bytes)
  )
    throw new Error('Published NSIS differs from the fixed native qualification identity');
  return manifest;
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
      return createActivePolicyVerifier(
        getResourceAuthorization(authorization).policy,
        authorization,
      )({
        receipt,
        signal: storeSignal,
      });
    },
    { signal },
  );
  if (!active) throw new Error('Authenticated official resource cache is unavailable');
  return authorization;
}
