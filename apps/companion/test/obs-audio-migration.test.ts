import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { AudioMigration, type AudioMigrationPlan } from '../src/obs/audio-migration.js';
import type { ObsRpc } from '../src/obs/reconcile.js';

it('restores desktop before disabling new paths after a failed switch', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mizar-migration-'));
  try {
    const values = new Map([
      [1, true],
      [2, false],
      [3, false],
    ]);
    const writes: [number, boolean][] = [];
    let failed = false;
    const obs: ObsRpc = {
      call: async (type, data) => {
        await Promise.resolve();
        if (type === 'GetStreamStatus' || type === 'GetRecordStatus')
          return { outputActive: false };
        if (type === 'GetSceneCollectionList') return { currentSceneCollectionName: 'Mizar' };
        if (type === 'GetSceneItemList')
          return {
            sceneItems: [...values].map(([sceneItemId, sceneItemEnabled]) => ({
              sceneItemId,
              sceneItemEnabled,
              sourceUuid: `id${sceneItemId}`,
            })),
          };
        if (type === 'SetSceneItemEnabled') {
          const id = data!.sceneItemId as number;
          const enabled = data!.sceneItemEnabled as boolean;
          if (id === 3 && enabled && !failed) {
            failed = true;
            throw new Error('failure');
          }
          writes.push([id, enabled]);
          values.set(id, enabled);
          return {};
        }
        throw new Error(type);
      },
    };
    const ref = (id: number) => ({ sceneName: 'scene', sceneItemId: id, sourceUuid: `id${id}` });
    const plan: AudioMigrationPlan = {
      endpoint: 'local',
      collection: 'Mizar',
      desktop: [ref(1)],
      independent: [ref(2), ref(3)],
    };
    const owner = new AudioMigration(join(dir, 'journal'));
    await expect(owner.migrate(obs, 'local', plan)).rejects.toThrow('failure');
    expect([...values.values()]).toEqual([true, false, false]);
    expect(writes).toEqual([
      [1, false],
      [2, true],
      [1, true],
      [2, false],
    ]);
    expect(await owner.recover(obs, 'local')).toBe(false);
    await owner.migrate(obs, 'local', plan);
    expect([...values.values()]).toEqual([false, true, true]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('leaves its journal during active output and restores on a later idle retry', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mizar-migration-'));
  try {
    const values = new Map([
      [1, true],
      [2, false],
    ]);
    let active = false;
    const obs: ObsRpc = {
      call: async (type, data) => {
        await Promise.resolve();
        if (type === 'GetStreamStatus' || type === 'GetRecordStatus')
          return { outputActive: active };
        if (type === 'GetSceneCollectionList') return { currentSceneCollectionName: 'Mizar' };
        if (type === 'GetSceneItemList')
          return {
            sceneItems: [...values].map(([sceneItemId, sceneItemEnabled]) => ({
              sceneItemId,
              sceneItemEnabled,
              sourceUuid: `id${sceneItemId}`,
            })),
          };
        if (type === 'SetSceneItemEnabled') {
          values.set(data!.sceneItemId as number, data!.sceneItemEnabled as boolean);
          active = true;
          return {};
        }
        throw new Error(type);
      },
    };
    const ref = (id: number) => ({ sceneName: 'scene', sceneItemId: id, sourceUuid: `id${id}` });
    const plan: AudioMigrationPlan = {
      endpoint: 'local',
      collection: 'Mizar',
      desktop: [ref(1)],
      independent: [ref(2)],
    };
    const journal = join(dir, 'journal');
    await expect(new AudioMigration(journal).migrate(obs, 'local', plan)).rejects.toThrow(
      'context_changed',
    );
    await expect(new AudioMigration(journal).recover(obs, 'local')).rejects.toThrow(
      'context_changed',
    );
    active = false;
    // Do not simulate output activation while performing the recovery itself.
    const idleObs: ObsRpc = {
      call: async (type, data) => {
        if (type === 'SetSceneItemEnabled') {
          values.set(data!.sceneItemId as number, data!.sceneItemEnabled as boolean);
          return {};
        }
        return obs.call(type, data);
      },
    };
    expect(await new AudioMigration(journal).recover(idleObs, 'local')).toBe(true);
    expect([...values.values()]).toEqual([true, false]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
