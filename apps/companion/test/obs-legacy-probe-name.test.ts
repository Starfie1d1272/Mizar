import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { renameLegacyProbe } from '../src/obs/remote-commentary.js';
import type { ObsRpc } from '../src/obs/reconcile.js';

it('renames only the journal-owned legacy game input, preserving its UUID and other sources', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'obs-name-'));
  const path = join(dir, 'game');
  const old = 'Mizar · Game Audio 00000000-0000-4000-8000-000000000001';
  await writeFile(
    path,
    JSON.stringify({ endpoint: 'local', collection: 'Mizar', name: old, uuid: 'owned' }),
  );
  const inputs = [
    { inputName: old, inputUuid: 'owned', inputKind: 'wasapi_process_output_capture' },
    { inputName: '游戏声音', inputUuid: 'custom', inputKind: 'wasapi_output_capture' },
  ];
  let active = true;
  const obs: ObsRpc = {
    async call(type, data) {
      await Promise.resolve();
      if (type === 'GetStreamStatus' || type === 'GetRecordStatus') return { outputActive: active };
      if (type === 'GetSceneCollectionList') return { currentSceneCollectionName: 'Mizar' };
      if (type === 'GetInputList') return { inputs };
      if (type === 'SetInputName') {
        const item = inputs.find((input) => input.inputUuid === data?.inputUuid)!;
        item.inputName = String(data?.newInputName);
        return {};
      }
      throw new Error(type);
    },
  };
  try {
    await renameLegacyProbe(obs, path, 'local', 'Mizar', 'game');
    expect(inputs[0]!.inputName).toBe(old);
    active = false;
    await renameLegacyProbe(obs, path, 'local', 'Mizar', 'game');
    await renameLegacyProbe(obs, path, 'local', 'Mizar', 'game');
    expect(inputs).toEqual([
      { inputName: '游戏声音 2', inputUuid: 'owned', inputKind: 'wasapi_process_output_capture' },
      { inputName: '游戏声音', inputUuid: 'custom', inputKind: 'wasapi_output_capture' },
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
