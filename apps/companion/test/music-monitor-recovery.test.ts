import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { MusicStore } from '../src/music/store.js';
import { PreviewMonitor } from '../src/music/preview-monitor.js';
import { OBS_COLLECTION } from '../src/obs/desired-state.js';
import { createMusicDevice } from '../src/obs/music-device.js';
import type { ObsRpc } from '../src/obs/reconcile.js';

test('monitor restoration retains a lost receipt and confirms it by readback after restart', async (t) => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'mizar-monitor-recovery-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new MusicStore(directory);
  await store.load();
  const uuid = 'audition-source';
  const scope = 'owned-collection';
  const before = 'OBS_MONITORING_TYPE_NONE';
  const applied = 'OBS_MONITORING_TYPE_MONITOR_ONLY';
  await store.update((state) => {
    state.sources.stinger = uuid;
    state.sourceScopes.stinger = scope;
    state.previewMonitorLeases = [{ uuid, scope, before, applied, phase: 'borrowed' }];
  });

  let current = true;
  let writes = 0;
  let mode: string = applied;
  const obs: ObsRpc = {
    reportsDispatch: true,
    ownershipScope: async () => scope,
    withMutationGuard: (guard) => ({
      ...obs,
      call: async (method, input, dispatch) => {
        await Promise.resolve();
        if (method === 'SetInputAudioMonitorType') {
          current = false;
          guard();
        }
        return obs.call(method, input, dispatch);
      },
    }),
    call: async (method, input, dispatch) => {
      if (method === 'GetSceneCollectionList')
        return { currentSceneCollectionName: OBS_COLLECTION };
      if (method === 'GetInputList')
        return { inputs: [{ inputUuid: uuid, inputName: '音效', inputKind: 'ffmpeg_source' }] };
      if (method === 'GetInputAudioMonitorType') return { monitorType: mode };
      if (method === 'GetMediaInputStatus') return { mediaState: 'OBS_MEDIA_STATE_STOPPED' };
      if (method !== 'SetInputAudioMonitorType') throw new Error(`Unexpected request: ${method}`);
      assert.equal(input?.inputUuid, uuid);
      assert.equal(input?.monitorType, before);
      dispatch?.();
      writes++;
      mode = before;
      throw new Error('OBS reply lost after applying the monitor mode');
    },
  };
  const monitor = new PreviewMonitor(store, async () => null);
  const device = createMusicDevice(obs);
  assert.equal(await monitor.restore(device, () => current), false);
  assert.equal(writes, 0);
  assert.equal(store.state.previewMonitorLeases[0]?.phase, 'borrowed');

  // The next attempt is dispatched, but its result is unknown until the new owner reads it.
  assert.equal(await monitor.restore(device, () => true), false);
  assert.equal(writes, 1);
  const reopened = new MusicStore(directory);
  await reopened.load();
  assert.equal(reopened.state.previewMonitorLeases[0]?.phase, 'restoring');
  const recovery = new PreviewMonitor(reopened, async () => null);
  assert.equal(await recovery.restore(device, () => true), true);
  assert.deepEqual(reopened.state.previewMonitorLeases, []);
  assert.equal(writes, 1);
});
