import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { verifyPayload } from '../../../scripts/product-runtime.mjs';
import { installOfficialPack } from './install-official-pack.mjs';

/** Run in the authenticated deployed Core, using the existing Companion App. */
export async function completeBootstrap({
  app,
  coreRoot,
  corePlan,
  policy,
  inputs,
  tufCachePath,
  signal = new globalThis.AbortController().signal,
  onProgress,
}) {
  signal.throwIfAborted();
  corePlan = { ...corePlan };
  policy = { ...policy };
  // Reuse the product's real payload verifier, not NSIS's UI result or a supplied boolean.
  const artifact = await verifyPayload(coreRoot);
  signal.throwIfAborted();
  await access(join(coreRoot, 'installed.flag'));
  if (
    artifact.appVersion !== corePlan.version ||
    artifact.gitSha !== corePlan.gitSha ||
    artifact.artifactSha256 !== corePlan.contentDigest ||
    artifact.appVersion !== policy.coreVersion
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
  const resources = await installOfficialPack({
    store,
    inputs,
    policy,
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
