import { expect, it } from 'vitest';
import { BroadcastReferenceQueue } from '../../src/broadcast-config/reference-queue.js';

it('serializes a reference commit with a provider removal check', async () => {
  const queue = new BroadcastReferenceQueue();
  const events: string[] = [];
  let release!: () => void;
  let started!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const pending = queue.run(async () => {
    events.push('commit-start');
    started();
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    events.push('commit-end');
  });
  await entered;
  const removal = queue.run(() => {
    events.push('check-and-mark');
    return Promise.resolve();
  });
  expect(events).toEqual(['commit-start']);
  release();
  await Promise.all([pending, removal]);
  expect(events).toEqual(['commit-start', 'commit-end', 'check-and-mark']);
});

it('rejects a newly referenced version marked for deletion while allowing existing references', async () => {
  const { assertReferenceCommitAllowed } =
    await import('../../src/broadcast-config/reference-queue.js');
  const ref = { id: 'local:pack', version: '1', digest: 'a'.repeat(64) };
  const document = {
    modules: [],
    presets: [],
    active: { lock: { resources: [], tools: [] } },
    previousActive: null,
  } as unknown as import('@mizar/broadcast-config').BroadcastConfigDocument;
  const next = structuredClone(document);
  next.presets.push({
    schemaVersion: 1,
    id: 'preset',
    revision: 'r',
    name: 'Preset',
    bindings: [],
    origin: null,
    opaqueModules: [
      {
        module: 'future',
        schemaVersion: 1,
        source: ref,
        entryId: 'entry',
        presetEntryId: 'preset',
        required: false,
      },
    ],
  });
  await expect(
    assertReferenceCommitAllowed(document, next, () => Promise.resolve(true)),
  ).rejects.toThrow('resource_deleting');
  await expect(
    assertReferenceCommitAllowed(next, next, () => Promise.resolve(true)),
  ).resolves.toBeUndefined();
});
