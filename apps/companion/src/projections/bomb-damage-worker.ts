import { parentPort } from 'node:worker_threads';
import { findBundledMap, loadBundledMap } from 'cs2-c4-damage/node';
import { prepareBombDamage, type PreparedBombDamage } from '@mizar/core/projection';
import type { StandingC4Input } from 'cs2-c4-damage';

// Decode, parse, build the index and predict on the same thread. No field/index
// is transferred to the HTTP/GSI thread, and no match state is retained here.
const maps = new Map<string, PreparedBombDamage>();
async function handle(message: {
  evict?: string;
  id: number;
  mapName: string;
  input?: StandingC4Input;
}) {
  if (message.evict) {
    maps.delete(message.evict);
    return;
  }
  try {
    if (message.input) {
      const prepared = maps.get(message.mapName);
      if (!prepared) throw new Error('resource-not-ready');
      parentPort!.postMessage({ id: message.id, result: prepared.predict(message.input) });
      return;
    }
    const entry = findBundledMap(message.mapName);
    if (!entry) throw new Error('unsupported-map');
    let prepared = maps.get(entry.mapName);
    if (!prepared) {
      const field = await loadBundledMap(entry.mapName);
      if (
        field.metadata.mapName !== entry.mapName ||
        field.metadata.normalizedFieldSha256 !== entry.normalizedFieldSha256
      ) {
        throw new Error('resource-mismatch');
      }
      prepared = prepareBombDamage(field);
    }
    maps.delete(entry.mapName);
    maps.set(entry.mapName, prepared);

    const { mapName, modelRevision, resourceSha256 } = prepared;
    parentPort!.postMessage({
      id: message.id,
      result: { mapName, modelRevision, resourceSha256 },
    });
  } catch {
    parentPort!.postMessage({ id: message.id, error: 'resource-invalid' });
  }
}
parentPort!.on('message', (message: Parameters<typeof handle>[0]) => {
  void handle(message);
});
