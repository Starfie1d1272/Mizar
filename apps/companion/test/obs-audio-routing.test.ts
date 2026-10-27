import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { ObsAudioRouting } from '../src/obs/audio-routing.js';
import type { ObsRpc } from '../src/obs/reconcile.js';

it('binds only explicit current UUIDs and rejects stale windows, deleted sources and changed collections', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'audio-routing-'));
  try {
    let collection = 'A';
    let inputs = [
      { inputUuid: 'one', inputName: 'TeamSpeak', inputKind: 'wasapi_process_output_capture' },
      { inputUuid: 'two', inputName: 'TeamSpeak', inputKind: 'wasapi_process_output_capture' },
    ];
    const obs: ObsRpc = {
      call: async (type) => {
        await Promise.resolve();
        if (type === 'GetVersion')
          return {
            availableRequests: [
              'GetInputList',
              'GetInputSettings',
              'GetSceneCollectionList',
              'GetSpecialInputs',
              'GetSceneList',
              'GetSceneItemList',
              'GetGroupSceneItemList',
            ],
          };
        if (type === 'GetSceneCollectionList') return { currentSceneCollectionName: collection };
        if (type === 'GetInputList') return { inputs };
        if (type === 'GetSpecialInputs') return {};
        if (type === 'GetSceneList') return { scenes: [] };
        throw new Error(type);
      },
    };
    const routing = new ObsAudioRouting(join(dir, 'bindings.json'));
    const a = await routing.read(obs, 'ws://127.0.0.1:4455');
    const b = await routing.read(obs, 'ws://127.0.0.1:4455');
    expect(a.candidates).toHaveLength(2);
    await expect(
      routing.bind(
        obs,
        { role: 'game', selectionId: a.candidates[0]!.selectionId, revision: a.revision },
        'ws://127.0.0.1:4456',
      ),
    ).rejects.toThrow('audio_selection_changed');
    await routing.bind(
      obs,
      {
        role: 'remoteCommentary',
        selectionId: a.candidates[1]!.selectionId,
        revision: a.revision,
      },
      'ws://127.0.0.1:4455',
    );
    expect(
      (await routing.read(obs, 'ws://127.0.0.1:4455')).bindings.remoteCommentary?.inputUuid,
    ).toBe('two');
    expect((await routing.read(obs, 'ws://127.0.0.1:4456')).bindings.remoteCommentary?.valid).toBe(
      false,
    );
    await expect(
      routing.bind(
        obs,
        {
          role: 'game',
          selectionId: b.candidates[0]!.selectionId,
          revision: b.revision,
        },
        'ws://127.0.0.1:4455',
      ),
    ).rejects.toThrow('audio_revision_changed');
    const fresh = await routing.read(obs, 'ws://127.0.0.1:4455');
    inputs = [inputs[0]!];
    await expect(
      routing.bind(
        obs,
        {
          role: 'game',
          selectionId: fresh.candidates[1]!.selectionId,
          revision: fresh.revision,
        },
        'ws://127.0.0.1:4455',
      ),
    ).rejects.toThrow('audio_selection_changed');
    expect((await routing.read(obs, 'ws://127.0.0.1:4455')).bindings.remoteCommentary?.valid).toBe(
      false,
    );
    collection = 'B';
    expect(
      (await new ObsAudioRouting(join(dir, 'bindings.json')).read(obs, 'ws://127.0.0.1:4455'))
        .bindings.remoteCommentary?.valid,
    ).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('reports repeated nested paths and global desktop audio without changing OBS', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'audio-routing-'));
  const calls: string[] = [];
  try {
    const obs: ObsRpc = {
      call: async (type, args) => {
        await Promise.resolve();
        calls.push(type);
        if (type === 'GetVersion')
          return {
            availableRequests: [
              'GetInputList',
              'GetInputSettings',
              'GetSceneCollectionList',
              'GetSpecialInputs',
              'GetSceneList',
              'GetSceneItemList',
              'GetGroupSceneItemList',
            ],
          };
        if (type === 'GetSceneCollectionList') return { currentSceneCollectionName: 'A' };
        if (type === 'GetInputList')
          return {
            inputs: [
              { inputUuid: 'x', inputName: '应用', inputKind: 'wasapi_process_output_capture' },
            ],
          };
        if (type === 'GetSpecialInputs') return { desktop1: '桌面音频' };
        if (type === 'GetSceneList') return { scenes: [{ sceneName: '主场景' }] };
        if (type === 'GetSceneItemList')
          return {
            sceneItems:
              args?.sceneName === '主场景'
                ? [
                    { sourceName: '应用', sourceUuid: 'x', sceneItemEnabled: true },
                    {
                      sourceName: '子场景',
                      sourceType: 'OBS_SOURCE_TYPE_SCENE',
                      sceneItemEnabled: true,
                    },
                  ]
                : [{ sourceName: '应用', sourceUuid: 'x', sceneItemEnabled: true }],
          };
        throw new Error(type);
      },
    };
    const status = await new ObsAudioRouting(join(dir, 'state')).read(obs, 'ws://127.0.0.1:4455');
    expect(status.findings.some((s) => s.includes('全局桌面'))).toBe(true);
    expect(status.findings.some((s) => s.includes('出现 2 次'))).toBe(true);
    expect(calls.every((name) => name.startsWith('Get'))).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
