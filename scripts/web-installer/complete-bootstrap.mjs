import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { verifyPayload } from '../../../scripts/product-runtime.mjs';
import { getResourceAuthorization } from '@mizar/resource-pack-contract/runtime';
import { restoreResourceAuthorization } from './published-bootstrap.mjs';
import { installOfficialPack } from './install-official-pack.mjs';

/** Run in the authenticated deployed Core, using the existing Companion App. */
export async function completeBootstrap({
  app,
  coreRoot,
  corePlan,
  authorization,
  inputs,
  tufCachePath,
  signal = new globalThis.AbortController().signal,
  onProgress,
}) {
  signal.throwIfAborted();
  corePlan = { ...corePlan };
  // Reuse the product's real payload verifier, not NSIS's UI result or a supplied boolean.
  const artifact = await verifyPayload(coreRoot);
  signal.throwIfAborted();
  await access(join(coreRoot, 'installed.flag'));
  if (
    artifact.appVersion !== corePlan.version ||
    artifact.gitSha !== corePlan.gitSha ||
    artifact.artifactSha256 !== corePlan.contentDigest
  ) {
    throw new Error('Installed Core identity does not match the authenticated bootstrap plan');
  }
  await app.ready();
  signal.throwIfAborted();
  if (!app.hasDecorator('getResourceStore'))
    throw new Error('Companion resource Store is unavailable; installation is incomplete');
  const store = app.getDecorator('getResourceStore')();
  if (!store)
    throw new Error('Companion resource Store is unavailable; installation is incomplete');
  authorization ??= await restoreResourceAuthorization({
    store,
    expectedCore: { appVersion: artifact.appVersion, gitSha: artifact.gitSha },
    signal,
  });
  const identity = getResourceAuthorization(authorization);
  if (
    identity.core.appVersion !== artifact.appVersion ||
    identity.core.gitSha !== artifact.gitSha ||
    (corePlan.coreSha256 !== undefined && identity.core.archiveSha256 !== corePlan.coreSha256)
  )
    throw new Error('Resource catalog belongs to another authenticated Core');
  const resources = await installOfficialPack({
    store,
    inputs,
    authorization,
    tufCachePath,
    signal,
    onProgress,
  });
  signal.throwIfAborted();
  return {
    coreInstalled: true,
    resourcesReady: true,
    core: {
      version: artifact.appVersion,
      gitSha: artifact.gitSha,
      contentDigest: artifact.artifactSha256,
    },
    resources,
  };
}
