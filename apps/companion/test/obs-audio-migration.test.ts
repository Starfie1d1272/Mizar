import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import {
  AudioMigration,
  type AudioMigrationPlan,
  type MigrationEvent,
  type MigrationObserver,
} from '../src/obs/audio-migration.js';
import type { ObsRpc } from '../src/obs/reconcile.js';

const ref = (id: number) => ({ sceneName: 'scene', sceneItemId: id, sourceUuid: `id${id}` });
const plan: AudioMigrationPlan = {
  endpoint: 'local',
  collection: 'Mizar',
  independent: [ref(1), ref(2)],
  desktop: [ref(3), ref(4)],
};
function fixture() {
  const values = new Map([
    [1, false],
    [2, false],
    [3, true],
    [4, true],
  ]);
  const calls: [number, boolean][] = [];
  let listener: (event: MigrationEvent) => void = () => undefined;
  let output = false;
  let identity = true;
  let hook: (id: number, enabled: boolean) => Promise<void> = async () => {
    await Promise.resolve();
  };
  const emit = (event: MigrationEvent) => {
    if (event.type === 'outputStarting') output = true;
    if (event.type === 'identityChanged') identity = false;
    listener(event);
  };
  const observer: MigrationObserver = {
    subscribe: (fn) => {
      listener = fn;
      return () => {
        listener = () => undefined;
      };
    },
  };
  const obs: ObsRpc = {
    call: async (type, data) => {
      if (type === 'GetStreamStatus' || type === 'GetRecordStatus') return { outputActive: output };
      if (type === 'GetSceneCollectionList')
        return { currentSceneCollectionName: identity ? 'Mizar' : 'Other' };
      if (type === 'GetSceneItemList')
        return {
          sceneItems: [...values].map(([id, enabled]) => ({
            sceneItemId: id,
            sourceUuid: `id${id}`,
            sceneItemEnabled: enabled,
          })),
        };
      if (type === 'SetSceneItemEnabled') {
        const id = data!.sceneItemId as number;
        const enabled = data!.sceneItemEnabled as boolean;
        values.set(id, enabled);
        calls.push([id, enabled]);
        emit({ type: 'item', sceneName: 'scene', sceneItemId: id, enabled });
        await hook(id, enabled);
        return {};
      }
      throw new Error(type);
    },
  };
  return {
    values,
    calls,
    obs,
    observer,
    emit,
    setHook: (fn: typeof hook) => {
      hook = fn;
    },
  };
}

for (const point of [1, 2, 3, 4])
  it(`compensates only writes sent before output starts at step ${point}`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mizar-migration-'));
    try {
      const f = fixture();
      let writes = 0;
      f.setHook(async () => {
        if (++writes === point) f.emit({ type: 'outputStarting' });
        await Promise.resolve();
      });
      const owner = new AudioMigration(join(dir, 'journal'));
      await expect(owner.migrate(f.obs, 'local', plan, f.observer)).rejects.toThrow(
        'output_started',
      );
      expect([...f.values.values()]).toEqual([false, false, true, true]);
      expect(await owner.pending()).toBeNull();
      expect(f.calls.slice(0, point).map(([id]) => id)).toEqual([1, 2, 3, 4].slice(0, point));
      const rollback = f.calls.slice(point);
      const restoreOld = rollback.findIndex(([id]) => id >= 3);
      const disableNew = rollback.findIndex(([id]) => id <= 2);
      if (restoreOld >= 0 && disableNew >= 0) expect(restoreOld).toBeLessThan(disableNew);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

it('does not compensate an uncertain in-flight write after disconnection even if it returns late', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mizar-migration-'));
  try {
    const f = fixture();
    let release = () => {};
    f.setHook(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
          f.emit({ type: 'disconnected' });
        }),
    );
    const owner = new AudioMigration(join(dir, 'journal'));
    await expect(owner.migrate(f.obs, 'local', plan, f.observer)).rejects.toThrow('uncertain');
    expect(f.calls).toEqual([[1, true]]);
    expect((await owner.pending())?.fields[0]?.phase).toBe('uncertain');
    release();
    await Promise.resolve();
    expect(f.calls).toHaveLength(1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('yields to an item manually changed away and back', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mizar-migration-'));
  try {
    const f = fixture();
    f.setHook(async (id) => {
      if (id === 1) {
        f.emit({ type: 'item', sceneName: 'scene', sceneItemId: 1, enabled: false });
        f.emit({ type: 'item', sceneName: 'scene', sceneItemId: 1, enabled: true });
        f.emit({ type: 'outputStarting' });
      }
      await Promise.resolve();
    });
    const owner = new AudioMigration(join(dir, 'journal'));
    await expect(owner.migrate(f.obs, 'local', plan, f.observer)).rejects.toThrow();
    expect(f.calls).toEqual([[1, true]]);
    expect((await owner.pending())?.fields[0]?.externalChanged).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('does not compensate after identity changes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mizar-migration-'));
  try {
    const f = fixture();
    f.setHook(async () => {
      f.emit({ type: 'identityChanged' });
      await Promise.resolve();
    });
    const owner = new AudioMigration(join(dir, 'journal'));
    await expect(owner.migrate(f.obs, 'local', plan, f.observer)).rejects.toThrow();
    expect(f.calls).toEqual([[1, true]]);
    expect(await owner.pending()).not.toBeNull();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('keeps new paths enabled when restoring old audio fails', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mizar-migration-'));
  try {
    const f = fixture();
    f.setHook(async (id, enabled) => {
      if (id === 3 && !enabled) f.emit({ type: 'outputStarting' });
      if (id === 3 && enabled) throw new Error('lost acknowledgement');
      await Promise.resolve();
    });
    const owner = new AudioMigration(join(dir, 'journal'));
    await expect(owner.migrate(f.obs, 'local', plan, f.observer)).rejects.toThrow();
    expect(f.calls).toEqual([
      [1, true],
      [2, true],
      [3, false],
      [3, true],
    ]);
    expect(f.values.get(1)).toBe(true);
    expect((await owner.pending())?.fields.find((field) => field.sceneItemId === 3)?.phase).toBe(
      'uncertain',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('keeps a sent write uncertain on a lost acknowledgement without compensating', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mizar-migration-'));
  try {
    const f = fixture();
    f.setHook(async () => {
      await Promise.resolve();
      throw new Error('lost acknowledgement');
    });
    const owner = new AudioMigration(join(dir, 'journal'));
    await expect(owner.migrate(f.obs, 'local', plan, f.observer)).rejects.toThrow('uncertain');
    expect(f.calls).toEqual([[1, true]]);
    expect((await owner.pending())?.fields[0]?.phase).toBe('uncertain');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('switches new paths first and clears a completed transaction', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mizar-migration-'));
  try {
    const f = fixture();
    const owner = new AudioMigration(join(dir, 'journal'));
    await owner.migrate(f.obs, 'local', plan, f.observer);
    expect(f.calls).toEqual([
      [1, true],
      [2, true],
      [3, false],
      [4, false],
    ]);
    expect(await owner.pending()).toBeNull();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

for (const point of [1, 2, 3, 4])
  it(`stops without compensation when identity changes at step ${point}`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mizar-migration-'));
    try {
      const f = fixture();
      let count = 0;
      f.setHook(async () => {
        if (++count === point) f.emit({ type: 'identityChanged' });
        await Promise.resolve();
      });
      const owner = new AudioMigration(join(dir, 'journal'));
      await expect(owner.migrate(f.obs, 'local', plan, f.observer)).rejects.toThrow();
      expect(f.calls).toHaveLength(point);
      expect(await owner.pending()).not.toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

for (const point of [1, 2, 3, 4])
  it(`does not compensate a lost acknowledgement at step ${point}`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mizar-migration-'));
    try {
      const f = fixture();
      let count = 0;
      f.setHook(async () => {
        if (++count === point) throw new Error('ack lost');
        await Promise.resolve();
      });
      const owner = new AudioMigration(join(dir, 'journal'));
      await expect(owner.migrate(f.obs, 'local', plan, f.observer)).rejects.toThrow('uncertain');
      expect(f.calls).toHaveLength(point);
      expect((await owner.pending())?.fields[point - 1]?.phase).toBe('uncertain');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

for (const point of [1, 2, 3, 4])
  it(`preserves manual changes away and back at step ${point}`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mizar-migration-'));
    try {
      const f = fixture();
      let count = 0;
      f.setHook(async (id, enabled) => {
        if (++count === point) {
          f.emit({ type: 'item', sceneName: 'scene', sceneItemId: id, enabled: !enabled });
          f.emit({ type: 'item', sceneName: 'scene', sceneItemId: id, enabled });
          f.emit({ type: 'outputStarting' });
        }
        await Promise.resolve();
      });
      const owner = new AudioMigration(join(dir, 'journal'));
      await expect(owner.migrate(f.obs, 'local', plan, f.observer)).rejects.toThrow();
      expect((await owner.pending())?.fields[point - 1]?.externalChanged).toBe(true);
      expect(f.calls.filter(([id]) => id === point)).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

it('observes OBS starting even before outputActive becomes true', async () => {
  const { observeAudioMigration } = await import('../src/obs/audio-migration-observer.js');
  const handlers = new Map<string, (payload: unknown) => void>();
  const events: MigrationEvent[] = [];
  const stop = observeAudioMigration({
    on: (name, fn) => {
      handlers.set(name, fn);
    },
    off: (name) => {
      handlers.delete(name);
    },
  }).subscribe((event) => events.push(event));
  handlers.get('StreamStateChanged')?.({
    outputActive: false,
    outputState: 'OBS_WEBSOCKET_OUTPUT_STARTING',
  });
  handlers.get('SceneItemEnableStateChanged')?.({
    sceneName: 'scene',
    sceneItemId: 1,
    sceneItemEnabled: true,
  });
  handlers.get('InputSettingsChanged')?.({});
  expect(events).toEqual([
    { type: 'outputStarting' },
    { type: 'item', sceneName: 'scene', sceneItemId: 1, enabled: true },
    { type: 'identityChanged' },
  ]);
  stop();
  expect(handlers.size).toBe(0);
});
