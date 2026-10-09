import { Buffer } from 'node:buffer';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { PACK_ID, REPLAY_IDS, LIMITS } from '@mizar/resource-pack-contract';
import { verifyResourcePublicationBytes } from '@mizar/resource-pack-contract/runtime';

/**
 * The caller supplies the existing App ResourceStore and its real authorization
 * adapter, including offline receipt verification. This module creates no Store,
 * trust root, resource state, listener, or alternate cache.
 * policy is pinned by the authenticated Core/bootstrap descriptor, never a mirror.
 */
export async function installOfficialPack({
  store,
  inputs,
  policy,
  tufCachePath,
  signal = new globalThis.AbortController().signal,
  onProgress = () => {},
}) {
  signal.throwIfAborted();
  // A version is not a trusted content identity. Until Store exposes active receipt
  // revalidation against the caller's policy, never reuse its version-only fast path.
  const frozenInputs = Object.fromEntries(
    [
      ['statementBytes', 64 * 1024],
      ['publicationBundleBytes', 2 * 1024 * 1024],
      ['archiveBytes', LIMITS.archiveBytes],
      ['archiveBundleBytes', 2 * 1024 * 1024],
    ].map(([name, maximum]) => {
      const bytes = inputs[name];
      if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > maximum) {
        throw new Error('Official resource input exceeds the publisher contract');
      }
      return [name, Buffer.from(bytes)];
    }),
  );
  const verified = await verifyResourcePublicationBytes({
    ...frozenInputs,
    policy: { ...policy, now: Date.now() },
    tufCachePath,
    signal,
  });
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
      return verified.receipt;
    },
    { packVersion: verified.manifest.packVersion, signal, force: true },
  );
  const status = store.getStatus(PACK_ID);
  if (
    status.phase !== 'ready' ||
    status.activeVersion !== verified.manifest.packVersion ||
    status.preparedVersion !== null
  ) {
    throw new Error('Default official resources are not active; installation is incomplete');
  }
  await assertDefaultEplReadable(store, signal);
  return { packId: PACK_ID, packVersion: status.activeVersion, resourcesReady: true };
}

/** Preserve the old Web URLs while delegating all authorization/Range work to Store. */
export async function readOfficialWebResource(store, path, range) {
  if (typeof path !== 'string') return undefined;
  const official =
    REPLAY_IDS.some((id) => path.startsWith(`fixtures/${id}/`)) ||
    path.startsWith('fixture-media/epl-s24/');
  if (!official) return undefined;
  return store.read(PACK_ID, path, range);
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
