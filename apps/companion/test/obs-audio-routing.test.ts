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
        if (type === 'GetSceneCollectionList') return { currentSceneCollectionName: collection };
        if (type === 'GetInputList') return { inputs };
        if (type === 'GetSpecialInputs') return {};
        if (type === 'GetSceneList') return { scenes: [] };
        throw new Error(type);
      },
    };
    const routing = new ObsAudioRouting(join(dir, 'bindings.json'));
    const a = await routing.read(obs);
    const b = await routing.read(obs);
    expect(a.candidates).toHaveLength(2);
    const bound = await routing.bind(obs, {
      role: 'remoteCommentary',
      selectionId: a.candidates[1]!.selectionId,
      revision: a.revision,
    });
    expect(bound.bindings.remoteCommentary?.inputUuid).toBe('two');
    await expect(
      routing.bind(obs, {
        role: 'game',
        selectionId: b.candidates[0]!.selectionId,
        revision: b.revision,
      }),
    ).rejects.toThrow('audio_revision_changed');
    const fresh = await routing.read(obs);
    inputs = [inputs[0]!];
    await expect(
      routing.bind(obs, {
        role: 'game',
        selectionId: fresh.candidates[1]!.selectionId,
        revision: fresh.revision,
      }),
    ).rejects.toThrow('audio_selection_changed');
    expect((await routing.read(obs)).bindings.remoteCommentary?.valid).toBe(false);
    collection = 'B';
    expect(
      (await new ObsAudioRouting(join(dir, 'bindings.json')).read(obs)).bindings.remoteCommentary
        ?.valid,
    ).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
