import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { PACK_ID, REPLAY_IDS } from '@mizar/resource-pack-contract';
import { getResourceAuthorization } from '@mizar/resource-pack-contract/runtime';
import { createActivePolicyVerifier } from '../resource-store/runtime-adapter.js';

/**
 * The caller supplies the existing App ResourceStore and its real authorization
 * adapter, including offline receipt verification. This module creates no Store,
 * trust root, resource state, listener, or alternate cache.
 * policy is pinned by the authenticated Core/bootstrap descriptor, never a mirror.
 */
export async function installOfficialPack({
  store,
  loadVerified,
  authorization,
  signal = new globalThis.AbortController().signal,
  onProgress = () => {},
}) {
  signal.throwIfAborted();
  const identity = getResourceAuthorization(authorization);
  const pinnedPolicy = { ...identity.policy, manifestSha256: identity.manifestSha256 };
  const verifyCurrent = createActivePolicyVerifier(pinnedPolicy, authorization);
  let renewedReceipt;
  const verifyActive = async (input) => {
    const verified = await verifyCurrent(input);
    // Retain authenticated old Core authorization even when actual cache files
    // need repair. The replacement ZIP is independently verified below.
    renewedReceipt = verified.receipt;
    return verified;
  };
  let cached;
  try {
    cached = await store.reuseActive(PACK_ID, verifyActive, { signal });
  } catch (error) {
    // A rejected historical/corrupt cache may be replaced only by a separately
    // authenticated new publication. Offline identity failures remain failures.
    if (signal.aborted || !loadVerified) throw error;
  }
  if (cached)
    return finishOfficialPack(store, cached, pinnedPolicy, signal, undefined, authorization);
  if (!loadVerified) throw new Error('Authenticated resource cache is unavailable');
  const verified = await loadVerified(signal);
  signal.throwIfAborted();
  // The shared verifier owns the receipt schema and offline trust snapshot.
  // Forward its authenticated receipt unchanged; do not reconstruct evidence here.
  await store.installVerified(
    PACK_ID,
    async ({ directory, signal: preparationSignal, onProgress: storeProgress }) => {
      let bytes = 0;
      for (const file of verified.manifest.files) {
        preparationSignal.throwIfAborted();
        const path = join(directory, file.path);
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        // Only frozen bytes returned by the real publisher verifier are consumed.
        // ResourceStore independently verifies actual copies before activation.
        await writeFile(path, verified.entries.get(file.path), { flag: 'wx', mode: 0o600 });
        bytes += file.bytes;
        storeProgress(bytes);
        onProgress(bytes);
      }
      preparationSignal.throwIfAborted();
      return renewedReceipt ?? verified.receipt;
    },
    { packVersion: verified.manifest.packVersion, signal, force: true },
  );
  const active = await store.reuseActive(PACK_ID, verifyActive, { signal });
  return finishOfficialPack(
    store,
    active,
    pinnedPolicy,
    signal,
    verified.manifestSha256,
    authorization,
  );
}

async function assertDefaultEplReadable(store, signal) {
  for (const id of REPLAY_IDS) {
    signal.throwIfAborted();
    await store.read(PACK_ID, `fixtures/${id}/replay/manifest.json`);
  }
  signal.throwIfAborted();
  await store.read(PACK_ID, 'fixtures/epl-inferno-video/replay/background.mp4', 'bytes=0-31');
  signal.throwIfAborted();
}

async function finishOfficialPack(
  store,
  active,
  policy,
  signal,
  expectedManifest = policy.manifestSha256,
  authorization,
) {
  if (
    !active ||
    active.status.phase !== 'ready' ||
    active.status.activeVersion !== policy.packVersion ||
    active.identity.packId !== PACK_ID ||
    active.identity.packVersion !== policy.packVersion ||
    active.identity.sourceSha !== policy.sourceSha ||
    active.identity.promotionSha !== policy.promotionSha ||
    (expectedManifest !== undefined && active.identity.manifestSha256 !== expectedManifest)
  ) {
    throw new Error('Default official resource identity is not active; installation is incomplete');
  }
  await assertDefaultEplReadable(store, signal);
  // Reads return snapshots; confirm the active identity still matches after them.
  const confirmed = await store.reuseActive(
    PACK_ID,
    createActivePolicyVerifier(policy, authorization),
    {
      signal,
    },
  );
  if (!confirmed || JSON.stringify(confirmed.identity) !== JSON.stringify(active.identity)) {
    throw new Error('Default official resource identity changed before completion');
  }
  signal.throwIfAborted();
  return { ...confirmed.identity, resourcesReady: true };
}
