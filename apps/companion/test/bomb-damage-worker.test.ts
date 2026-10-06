import { describe, expect, it, vi } from 'vitest';
import { loadBundledMap } from 'cs2-c4-damage/node';
import { prepareBombDamage } from '@mizar/core/projection';
import { BombDamageWorkerClient } from '../src/projections/bomb-damage-worker-client.js';

describe('C4 worker isolation', () => {
  it('matches the direct model, keys results by every input and ignores old contexts', async () => {
    const changed = vi.fn();
    const worker = new BombDamageWorkerClient(changed);
    try {
      const prepared = await worker.load('de_ancient');
      const field = await loadBundledMap('de_ancient');
      const site = field.bombsites[0]!;
      const input = {
        bombPosition: {
          x: (site.boundsMin.x + site.boundsMax.x) / 2,
          y: (site.boundsMin.y + site.boundsMax.y) / 2,
          z: (site.boundsMin.z + site.boundsMax.z) / 2,
        },
        playerPosition: field.positions[100]!,
        playerForward: { x: 1, y: 0, z: 0 },
        health: 100,
      };
      const direct = prepareBombDamage(field);
      expect(direct.predict(input).status).toBe('predicted');
      worker.setContext('generation-1:map-1');
      expect(prepared.predict(input)).toEqual({
        status: 'unavailable',
        reason: 'prediction-loading',
      });
      await worker.settle();
      expect(prepared.predict(input)).toEqual(direct.predict(input));
      for (let health = 60; health < 71; health++)
        expect(prepared.predict({ ...input, health }).status).toBe('unavailable');
      await worker.settle();
      expect(prepared.predict({ ...input, health: 60 })).toEqual(
        direct.predict({ ...input, health: 60 }),
      );
      expect(prepared.predict({ ...input, health: 70 }).status).toBe('unavailable');
      await worker.settle();
      expect(prepared.predict({ ...input, health: 70 })).toEqual(
        direct.predict({ ...input, health: 70 }),
      );
      expect(prepared.predict({ ...input, health: 50 }).status).toBe('unavailable');
      worker.setContext('generation-2:map-1');
      await worker.settle();
      expect(prepared.predict(input).status).toBe('unavailable');
      await worker.settle();
      expect(prepared.predict(input)).toEqual(direct.predict(input));
      expect(prepared.predict({ ...input, health: 50 }).status).toBe('unavailable');
      await worker.settle();
      expect(prepared.predict({ ...input, health: 50 })).toEqual(
        direct.predict({ ...input, health: 50 }),
      );
    } finally {
      worker.close();
    }
  }, 15_000);
  it('degrades invalid resources and cancels an in-flight load on shutdown', async () => {
    const worker = new BombDamageWorkerClient(() => {});
    await expect(worker.load('de_unknown')).rejects.toThrow('resource-invalid');
    const pending = worker.load('de_mirage');
    worker.close();
    await expect(pending).rejects.toThrow('worker-unavailable');
    await expect(worker.load('de_ancient')).rejects.toThrow('worker-closed');
  });
});
