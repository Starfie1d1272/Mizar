import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { access } from 'node:fs/promises';
import { randomUUID, randomBytes } from 'node:crypto';
import { createCancelControl } from './cancel-control.mjs';
import { verifyPayload, writableRoot } from '../../../scripts/product-runtime.mjs';

// This executable entry is shipped inside Core and invoked by its embedded Node.
// It imports the actual product App only after the whole Core passes verification.
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
let app;
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
  const { buildApp } = await import('../app.js');
  const { defaultResourceRoot } = await import('../resource-store/store.js');
  const { authenticatePublishedBootstrap, restoreResourceAuthorization } =
    await import('./published-bootstrap.mjs');
  const { completeBootstrap } = await import('./complete-bootstrap.mjs');
  const stateRoot = writableRoot(coreRoot);
  const tufCachePath = join(stateRoot, 'updates', 'trust');
  app = buildApp({
    resources: { root: defaultResourceRoot() },
    productRuntime: {
      appVersion: artifact.appVersion,
      gitSha: artifact.gitSha,
      artifactSha256: artifact.artifactSha256,
      instanceId: randomUUID(),
      controlToken: randomBytes(32).toString('hex'),
      stop: () => cancellation.abort(),
    },
  });
  await app.ready();
  const store = app.getDecorator('getResourceStore')();
  if (!store) throw new Error('Actual product resource Store is unavailable');
  let authorization, inputs, loadInputs;
  try {
    authorization = await restoreResourceAuthorization({
      store,
      expectedCore: { appVersion: artifact.appVersion, gitSha: artifact.gitSha },
      signal,
    });
  } catch {
    signal.throwIfAborted();
    ({ authorization, inputs, loadInputs } = await authenticatePublishedBootstrap({
      version: artifact.appVersion,
      expectedCore: { ...nativePlan, coreMode: artifact.resourceMode === 'core' },
      tufCachePath,
      signal,
    }));
  }
  const result = await completeBootstrap({
    app,
    coreRoot,
    corePlan: nativePlan,
    authorization,
    inputs,
    loadInputs,
    tufCachePath,
    signal,
  });
  // Release the exact product Store writer before the native host starts Mizar.
  await app.close();
  app = undefined;
  signal.throwIfAborted();
  process.stdout.write(
    `${JSON.stringify({ schemaVersion: 'mizar.bootstrap-result.v1', ...result })}\n`,
  );
} catch (error) {
  process.stderr.write(
    `${JSON.stringify({ code: 'bootstrap_incomplete', message: String(error.message).slice(0, 512) })}\n`,
  );
  process.exitCode = 1;
} finally {
  await app?.close();
  process.stdin.destroy();
}
