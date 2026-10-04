import { describe, expect, it, vi } from 'vitest';
import { loadBundledMap } from 'cs2-c4-damage/node';
import { BombDamageResources } from '../src/projections/bomb-damage-resources.js';

describe('bounded C4 resources', () => {
  it('reuses loaded resources, degrades unsupported and invalid maps', async () => {
    const changed = vi.fn();
    const load = vi.fn(loadBundledMap);
    const resources = new BombDamageResources(changed, load);
    expect(resources.get('de_unknown')).toEqual({
      status: 'unavailable',
      reason: 'unsupported-map',
    });
    await resources.prepare('de_ancient');
    const first = resources.get('de_ancient');
    expect(first.status).toBe('ready');
    expect(resources.get('de_ancient')).toBe(first);
    expect(load).toHaveBeenCalledTimes(1);
    resources.close();
    const failed = new BombDamageResources(changed, () => Promise.reject(new Error('corrupt')));
    await failed.prepare('de_nuke');
    expect(failed.get('de_nuke')).toEqual({ status: 'unavailable', reason: 'resource-invalid' });
    failed.close();
  });
  it('does not publish an old result after close and bounds concurrent loads to one', async () => {
    let finish!: (field: Awaited<ReturnType<typeof loadBundledMap>>) => void;
    const load = vi.fn(
      () =>
        new Promise<Awaited<ReturnType<typeof loadBundledMap>>>((resolve) => {
          finish = resolve;
        }),
    );
    const changed = vi.fn();
    const resources = new BombDamageResources(changed, load);
    resources.get('de_ancient');
    resources.get('de_nuke');
    resources.get('de_mirage');
    expect(load).toHaveBeenCalledTimes(1);
    resources.close();
    finish(await loadBundledMap('de_ancient'));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(changed).not.toHaveBeenCalled();
  });
  it('rejects a mismatched map resource', async () => {
    const resources = new BombDamageResources(
      () => {},
      () => loadBundledMap('de_ancient'),
    );
    await resources.prepare('de_nuke');
    expect(resources.get('de_nuke').status).toBe('unavailable');
    resources.close();
  });
});
