import { inspect } from 'node:util';
import { safeLogText } from '../../../scripts/product-logs.mjs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { access } from 'node:fs/promises';
import { createCancelControl } from './cancel-control.mjs';
import { verifyPayload, writableRoot } from '../../../scripts/product-runtime.mjs';

// This executable entry is shipped inside Core and invoked by its embedded Node.
// It uses ResourceStore directly without starting Fastify.
const coreRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const [version, gitSha, contentDigest, coreSha256, sha256, installerBytes] = process.argv.slice(2);
const nativePlan = {
  version,
  gitSha,
  contentDigest,
  coreSha256,
  sha256,
  bytes: Number(installerBytes),
};
const cancellation = new globalThis.AbortController();
const signal = globalThis.AbortSignal.any([
  cancellation.signal,
  globalThis.AbortSignal.timeout(480000),
]);
process.stdin.setEncoding('utf8');
process.stdin.on(
  'data',
  createCancelControl(() => cancellation.abort()),
);
let store;
try {
  if (
    !version ||
    !/^[a-f0-9]{40}$/.test(gitSha) ||
    !/^[a-f0-9]{64}$/.test(contentDigest) ||
    !/^[a-f0-9]{64}$/.test(coreSha256) ||
    !/^[a-f0-9]{64}$/.test(sha256) ||
    !Number.isSafeInteger(nativePlan.bytes) ||
    nativePlan.bytes < 1
  )
    throw new Error('Authenticated native Core plan is required');
  const artifact = await verifyPayload(coreRoot);
  await access(join(coreRoot, 'installed.flag'));
  signal.throwIfAborted();
  if (
    artifact.appVersion !== version ||
    artifact.gitSha !== gitSha ||
    artifact.artifactSha256 !== contentDigest
  )
    throw new Error('Installed Core differs from authenticated native plan');
  const { ResourceStore, defaultResourceRoot } = await import('../resource-store/store.js');
  const { createRuntimeVerifier } = await import('../resource-store/runtime-adapter.js');
  const { authenticatePublishedBootstrap, restoreResourceAuthorization } =
    await import('./published-bootstrap.mjs');
  const { installOfficialPack } = await import('./install-official-pack.mjs');
  const { getResourceAuthorization } = await import('@mizar/resource-pack-contract/runtime');
  const stateRoot = writableRoot(coreRoot);
  const tufCachePath = join(stateRoot, 'updates', 'trust');
  store = await ResourceStore.open({
    root: defaultResourceRoot(),
    diagnostic: (packId, error) => {
      process.stderr.write(
        `${safeLogText(`[${packId}] ${inspect(error, { depth: 6, customInspect: false, getters: false })}`).slice(0, 4096)}\n`,
      );
    },
    verifyTrustedPack: createRuntimeVerifier(undefined, undefined, {
      appVersion: artifact.appVersion,
      gitSha: artifact.gitSha,
    }),
    activateWhenSafe: async (commit) => {
      await commit();
      return true;
    },
  });
  let authorization, loadVerified;
  try {
    authorization = await restoreResourceAuthorization({
      store,
      expectedCore: { appVersion: artifact.appVersion, gitSha: artifact.gitSha },
      signal,
    });
  } catch (cachedError) {
    process.stderr.write(
      `${safeLogText(inspect(cachedError, { depth: 8, customInspect: false, getters: false })).slice(0, 4096)}\n`,
    );
    signal.throwIfAborted();
    ({ authorization, loadVerified } = await authenticatePublishedBootstrap({
      version: artifact.appVersion,
      expectedCore: { ...nativePlan, coreMode: artifact.resourceMode === 'core' },
      tufCachePath,
      signal,
    }));
  }
  const identity = getResourceAuthorization(authorization);
  if (
    identity.core.appVersion !== version ||
    identity.core.gitSha !== gitSha ||
    identity.core.archiveSha256 !== coreSha256
  )
    throw new Error('Resource catalog belongs to another authenticated Core');
  const resources = await installOfficialPack({ store, authorization, loadVerified, signal });
  const result = {
    coreInstalled: true,
    resourcesReady: true,
    core: { version, gitSha, contentDigest },
    resources,
  };
  await store.shutdown();
  store = undefined;
  signal.throwIfAborted();
  process.stdout.write(
    `${JSON.stringify({ schemaVersion: 'mizar.bootstrap-result.v1', ...result })}\n`,
  );
} catch (error) {
  process.stderr.write(
    `${JSON.stringify({ code: 'bootstrap_incomplete', diagnostic: safeLogText(inspect(error, { depth: 8, customInspect: false, getters: false, maxStringLength: 4096 })).slice(0, 32768) })}\n`,
  );
  process.exitCode = 1;
} finally {
  await store?.shutdown();
  process.stdin.destroy();
}
