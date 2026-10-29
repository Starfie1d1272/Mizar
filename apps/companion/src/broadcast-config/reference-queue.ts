import { SerialCommitQueue } from '../match-context/serial-commit.js';

/**
 * Shared by configuration commits and resource providers. A provider must check
 * usages and mark the exact version unavailable inside the same operation;
 * physical cleanup may run after it returns.
 */
export class BroadcastReferenceQueue {
  private readonly queue = new SerialCommitQueue();

  run<T>(operation: () => Promise<T>): Promise<T> {
    return this.queue.run(operation);
  }
}

import { canonicalJson } from '@mizar/hud-config';
import { MUSIC_GROUPS } from '@mizar/protocol/music';
import type { BroadcastConfigDocument, ResourceRef } from '@mizar/broadcast-config';

/** Includes drafts, optional opaque entries and the active and recovery locks. */
export function broadcastResourceReferences(document: BroadcastConfigDocument): ResourceRef[] {
  const references = new Map<string, ResourceRef>();
  const add = (ref: ResourceRef) => {
    references.set(canonicalJson(ref), ref);
  };
  for (const module of document.modules) {
    if (module.kind === 'hud' && !('preset' in module.value)) {
      add(module.value.renderer.resource);
      for (const asset of Object.values(module.value.panelAssets)) add(asset.resource);
    } else if (module.kind === 'program') {
      for (const scene of Object.values(module.value.scenes))
        if (scene.kind === 'declarative') add(scene.resource);
      for (const asset of Object.values(module.value.assets)) add(asset.resource);
    } else if (module.kind === 'music') {
      for (const group of MUSIC_GROUPS)
        for (const track of module.value.groups[group].tracks) add(track.asset.resource);
    } else if (module.kind === 'camera') {
      for (const map of module.value.maps)
        if (map.openingSound) add(map.openingSound.asset.resource);
    }
  }
  for (const preset of document.presets)
    for (const opaque of preset.opaqueModules) add(opaque.source);
  for (const ref of document.active.lock.resources) add(ref);
  for (const ref of document.previousActive?.lock.resources ?? []) add(ref);
  return [...references.values()];
}

/** Call only while holding the queue, using the provider's authoritative deletion state. */
export async function assertReferenceCommitAllowed(
  previous: BroadcastConfigDocument,
  next: BroadcastConfigDocument,
  isDeleting: (ref: ResourceRef) => Promise<boolean>,
): Promise<void> {
  const existing = new Set(broadcastResourceReferences(previous).map(canonicalJson));
  for (const ref of broadcastResourceReferences(next)) {
    if (!existing.has(canonicalJson(ref)) && (await isDeleting(ref)))
      throw new Error('resource_deleting');
  }
}
