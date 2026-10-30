import { afterEach, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ObsCaptureWarmup } from '../src/obs/capture-warmup.js';
import { obsSceneName } from '../src/obs/desired-state.js';
import type { ObsRpc } from '../src/obs/reconcile.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function rig(
  options: {
    audio?: boolean | 'unknown';
    lostCreateAck?: boolean;
    afterTransform?: () => void;
    afterEnable?: () => void;
  } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), 'mizar-warmup-'));
  dirs.push(dir);
  const path = join(dir, 'journal.json');
  const controller = new ObsCaptureWarmup(path);
  const calls: string[] = [];
  let item: { sceneItemId: number; sourceUuid: string; sceneItemEnabled: boolean } | null = null;
  let geometry: Record<string, unknown> = {
    boundsType: 'OBS_BOUNDS_NONE',
    scaleX: 1,
    scaleY: 1,
    positionX: 0,
    positionY: 0,
    rotation: 0,
    width: 1920,
    height: 1080,
  };
  const obs: ObsRpc = {
    async call(type, data = {}) {
      calls.push(type);
      if (type === 'GetOutputList') return { outputs: [] };
      if (type === 'GetSceneCollectionList') return { currentSceneCollectionName: 'Mizar' };
      if (type === 'GetSceneList')
        return {
          currentProgramSceneName: obsSceneName('waiting'),
          scenes: [{ sceneName: obsSceneName('waiting'), sceneUuid: 'waiting-uuid' }],
        };
      if (type === 'GetInputList')
        return {
          inputs: [{ inputName: '游戏画面', inputKind: 'game_capture', inputUuid: 'capture-uuid' }],
        };
      if (type === 'GetInputSettings')
        return {
          inputSettings:
            options.audio === 'unknown' ? {} : { capture_audio: options.audio ?? false },
        };
      if (type === 'GetInputDefaultSettings') return { defaultInputSettings: {} };
      if (type === 'GetSceneItemList') return { sceneItems: item ? [item] : [] };
      if (type === 'CreateSceneItem') {
        item = { sceneItemId: 17, sourceUuid: 'capture-uuid', sceneItemEnabled: false };
        if (options.lostCreateAck) throw new Error('disconnected after create');
        return { sceneItemId: 17 };
      }
      if (type === 'GetSceneItemTransform') return { sceneItemTransform: geometry };
      if (type === 'SetSceneItemTransform') {
        geometry = { ...(data.sceneItemTransform as Record<string, unknown>), width: 0, height: 0 };
        options.afterTransform?.();
        return {};
      }
      if (type === 'SetSceneItemEnabled') {
        if (item) item.sceneItemEnabled = true;
        options.afterEnable?.();
        return {};
      }
      if (type === 'RemoveSceneItem') {
        item = null;
        return {};
      }
      throw new Error(`unexpected ${type}`);
    },
  };
  return {
    controller,
    obs,
    calls,
    path,
    item: () => item,
    changeCrop: () => {
      geometry = { ...geometry, cropLeft: 15 };
    },
  };
}
const prep = '00000000-0000-4000-8000-000000000001';

it('creates disabled, verifies zero transform, enables, and removes only its item', async () => {
  const r = await rig();
  const result = await r.controller.begin(
    r.obs,
    'endpoint',
    prep,
    () => true,
    () => true,
  );
  expect(result.startedAt).toBeGreaterThan(0);
  expect(r.calls.indexOf('CreateSceneItem')).toBeLessThan(r.calls.indexOf('SetSceneItemTransform'));
  expect(r.calls.indexOf('SetSceneItemTransform')).toBeLessThan(
    r.calls.indexOf('SetSceneItemEnabled'),
  );
  expect(await r.controller.confirm(r.obs, result.transactionId)).toBe(true);
  await r.controller.release(r.obs, 'endpoint', result.transactionId, () => true);
  await r.controller.release(r.obs, 'endpoint', result.transactionId, () => true);
  expect(r.item()).toBeNull();
  expect(r.calls.filter((name) => name === 'RemoveSceneItem')).toHaveLength(1);
});

it.each([true, 'unknown'] as const)('never creates an item when audio is %s', async (audio) => {
  const r = await rig({ audio });
  await expect(
    r.controller.begin(
      r.obs,
      'endpoint',
      prep,
      () => true,
      () => true,
    ),
  ).rejects.toThrow();
  expect(r.calls).not.toContain('CreateSceneItem');
});

it('cancellation after transform removes the still-disabled verified item', async () => {
  let valid = true;
  const r = await rig({
    afterTransform: () => {
      valid = false;
    },
  });
  await expect(
    r.controller.begin(
      r.obs,
      'endpoint',
      prep,
      () => valid,
      () => true,
    ),
  ).rejects.toThrow();
  expect(r.item()).toBeNull();
  expect(r.calls).not.toContain('SetSceneItemEnabled');
});

it('preserves the item and journal if the user changes its crop', async () => {
  const r = await rig();
  const result = await r.controller.begin(
    r.obs,
    'endpoint',
    prep,
    () => true,
    () => true,
  );
  r.changeCrop();
  await expect(
    r.controller.release(r.obs, 'endpoint', result.transactionId, () => true),
  ).rejects.toMatchObject({ code: 'capture_warmup_changed' });
  expect(r.calls).not.toContain('RemoveSceneItem');
  expect(JSON.parse(await readFile(r.path, 'utf8'))).toMatchObject({
    phase: 'enabled',
    itemId: 17,
  });
});

it('retains an ambiguous create result rather than guessing item ownership', async () => {
  const r = await rig({ lostCreateAck: true });
  await expect(
    r.controller.begin(
      r.obs,
      'endpoint',
      prep,
      () => true,
      () => true,
    ),
  ).rejects.toMatchObject({ code: 'capture_warmup_pending' });
  expect(r.item()).not.toBeNull();
  expect(r.calls).not.toContain('RemoveSceneItem');
  expect(JSON.parse(await readFile(r.path, 'utf8'))).toMatchObject({
    phase: 'creating',
    itemId: null,
    baselineIds: [],
  });
});

it('retains the journal without removal after external takeover', async () => {
  let lease = true;
  const r = await rig({
    afterEnable: () => {
      lease = false;
    },
  });
  await expect(
    r.controller.begin(
      r.obs,
      'endpoint',
      prep,
      () => true,
      () => lease,
    ),
  ).rejects.toMatchObject({ code: 'capture_warmup_pending' });
  expect(r.calls).not.toContain('RemoveSceneItem');
  expect(JSON.parse(await readFile(r.path, 'utf8'))).toMatchObject({
    phase: 'enabling',
    itemId: 17,
  });
});
