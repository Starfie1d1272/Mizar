import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { RemoteCommentary } from '../src/obs/remote-commentary.js';
import { discoverWaitingCommentary } from '../src/obs/remote-commentary-wait.js';
import type { ObsRpc } from '../src/obs/reconcile.js';

it('completes only the current waiting intent and leaves deleted or changed targets alone', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'commentary-wait-'));
  try {
    const owner = new RemoteCommentary(join(dir, 'intent'));
    const state = await owner.get();
    const journal = join(dir, 'probe');
    const writeWaiting = () =>
      writeFile(
        `${journal}.waiting`,
        JSON.stringify({
          endpoint: 'local',
          collection: 'Mizar',
          uuid: 'owned',
          revision: state.revision,
          phase: 'waiting',
        }),
      );
    let deleted = false;
    let window = '';
    let active = false;
    const writes: string[] = [];
    const obs: ObsRpc = {
      call: async (type, data) => {
        await Promise.resolve();
        if (type === 'GetStreamStatus' || type === 'GetRecordStatus')
          return { outputActive: active };
        if (type === 'GetSceneCollectionList') return { currentSceneCollectionName: 'Mizar' };
        if (type === 'GetInputList')
          return {
            inputs: deleted
              ? []
              : [{ inputUuid: 'owned', inputKind: 'wasapi_process_output_capture' }],
          };
        if (type === 'GetVersion')
          return {
            availableRequests: [
              'GetInputList',
              'GetInputSettings',
              'GetInputPropertiesListPropertyItems',
            ],
          };
        if (type === 'GetInputSettings') return { inputSettings: { window } };
        if (type === 'GetInputPropertiesListPropertyItems')
          return { propertyItems: [{ itemValue: 'TS:Qt:teamspeak.exe' }] };
        if (type === 'SetInputSettings') {
          window = (data!.inputSettings as { window: string }).window;
          writes.push(window);
          return {};
        }
        throw new Error(type);
      },
    };
    await writeWaiting();
    active = true;
    expect(await discoverWaitingCommentary(obs, owner, journal, 'local')).toBe('waiting');
    active = false;
    deleted = true;
    expect(await discoverWaitingCommentary(obs, owner, journal, 'local')).toBe('stopped');
    deleted = false;
    window = 'User:Qt:other.exe';
    expect(await discoverWaitingCommentary(obs, owner, journal, 'local')).toBe('stopped');
    window = '';
    expect(await discoverWaitingCommentary(obs, owner, journal, 'local')).toBe('complete');
    expect(writes).toEqual(['TS:Qt:teamspeak.exe']);
    window = '';
    expect(await discoverWaitingCommentary(obs, owner, journal, 'local')).toBe('stopped');
    await writeWaiting();
    await owner.set({ mode: 'disabled' }, state.revision);
    expect(await discoverWaitingCommentary(obs, owner, journal, 'local')).toBe('stopped');
    expect(writes).toHaveLength(1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
