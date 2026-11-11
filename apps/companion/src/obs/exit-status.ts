import { readFileSync, statSync } from 'node:fs';
import { replaceDurableJson } from '../match-context/durable-json.js';

function previouslyUnconfirmed(path: string | undefined): boolean {
  if (!path) return false;
  try {
    if (statSync(path).size > 4096) return true;
    const saved: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return (
      typeof saved !== 'object' ||
      saved === null ||
      (saved as { state?: unknown }).state !== 'confirmed'
    );
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ENOENT';
  }
}

export function createObsExitStatus(
  configPath: string | undefined,
  onError: (error: unknown) => void,
) {
  const path = configPath ? `${configPath}.exit-status.json` : undefined;
  let writes = Promise.resolve();
  return {
    previousUnconfirmed: previouslyUnconfirmed(path),
    async wait() {
      while (true) {
        const pending = writes;
        await pending;
        if (pending === writes) return;
      }
    },
    async record(state: 'pending' | 'confirmed' | 'unconfirmed', valid?: () => boolean) {
      if (!path) return;
      const pending = writes.then(async () => {
        await replaceDurableJson(path, { state }, valid ? { canCommit: valid } : {});
      });
      writes = pending.catch(onError);
      return pending;
    },
  };
}
