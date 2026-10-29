import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  AudioMigration,
  type MigrationEvent,
  type MigrationObserver,
} from '../src/obs/audio-migration.js';
import type { ObsRpc } from '../src/obs/reconcile.js';

function fixture() {
  const items = [
    { sceneItemId: 1, sourceUuid: 'old', sceneItemEnabled: true },
    { sceneItemId: 2, sourceUuid: 'new', sceneItemEnabled: false },
  ];
  const listeners = new Set<(event: MigrationEvent) => void>();
  let failAfterWrite = false;
  const observer: MigrationObserver = {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const obs: ObsRpc = {
    async call(type, data) {
      if (type === 'GetStreamStatus' || type === 'GetRecordStatus') return { outputActive: false };
      if (type === 'GetSceneCollectionList') return { currentSceneCollectionName: 'collection' };
      if (type === 'GetSceneItemList') return { sceneItems: items.map((item) => ({ ...item })) };
      if (type === 'SetSceneItemEnabled') {
        const item = items.find((value) => value.sceneItemId === data?.sceneItemId)!;
        item.sceneItemEnabled = data?.sceneItemEnabled as boolean;
        for (const listener of listeners)
          listener({
            type: 'item',
            sceneName: 'scene',
            sceneItemId: item.sceneItemId,
            enabled: item.sceneItemEnabled,
          });
        if (failAfterWrite) {
          failAfterWrite = false;
          throw new Error('receipt lost');
        }
        return {};
      }
      throw new Error(`Unexpected request ${type}`);
    },
  };
  const plan = {
    endpoint: 'endpoint',
    collection: 'collection',
    desktop: [{ sceneName: 'scene', sceneItemId: 1, sourceUuid: 'old' }],
    independent: [{ sceneName: 'scene', sceneItemId: 2, sourceUuid: 'new' }],
  };
  return {
    items,
    obs,
    observer,
    plan,
    failNextWrite: () => {
      failAfterWrite = true;
    },
  };
}

async function withJournal(run: (path: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'mizar-audio-migration-'));
  try {
    await run(join(dir, 'journal.json'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('completed migration retains a reversible record', async () =>
  withJournal(async (path) => {
    const { items, obs, observer, plan } = fixture();
    const migration = new AudioMigration(path);
    await migration.migrate(obs, 'endpoint', plan, observer, `${path}.completed`);
    assert.deepEqual(
      items.map((item) => item.sceneItemEnabled),
      [false, true],
    );
    assert.equal(
      await migration.restoreCompleted(obs, 'endpoint', observer, `${path}.completed`),
      true,
    );
    assert.deepEqual(
      items.map((item) => item.sceneItemEnabled),
      [true, false],
    );
  }));

test('lost write receipt is read back and restored after restart', async () =>
  withJournal(async (path) => {
    const { items, obs, observer, plan, failNextWrite } = fixture();
    failNextWrite();
    await assert.rejects(
      new AudioMigration(path).migrate(obs, 'endpoint', plan, observer),
      /write_uncertain/,
    );
    assert.deepEqual(
      items.map((item) => item.sceneItemEnabled),
      [false, false],
    );
    await new AudioMigration(path).recover(obs, 'endpoint', observer);
    assert.deepEqual(
      items.map((item) => item.sceneItemEnabled),
      [true, false],
    );
    assert.equal(await new AudioMigration(path).pending(), null);
  }));

test('completed restore does not overwrite an externally changed field', async () =>
  withJournal(async (path) => {
    const { items, obs, observer, plan } = fixture();
    const migration = new AudioMigration(path);
    await migration.migrate(obs, 'endpoint', plan, observer, `${path}.completed`);
    items[0]!.sceneItemEnabled = true;
    await assert.rejects(
      migration.restoreCompleted(obs, 'endpoint', observer, `${path}.completed`),
      /external_change/,
    );
    assert.deepEqual(
      items.map((item) => item.sceneItemEnabled),
      [true, true],
    );
  }));
