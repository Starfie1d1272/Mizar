import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createCommentaryProbe, RemoteCommentary } from '../src/obs/remote-commentary.js';
import type { ObsRpc } from '../src/obs/reconcile.js';

it('persists manual preferences and rejects stale revisions across restarts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'commentary-'));
  try {
    const owner = new RemoteCommentary(join(dir, 'intent'));
    const initial = await owner.get();
    expect(initial.preference.mode).toBe('autoTeamspeak');
    const manual = await owner.set(
      { mode: 'application', window: 'Chat:Class:other.exe' },
      initial.revision,
    );
    await expect(owner.set({ mode: 'disabled' }, initial.revision)).rejects.toThrow(
      'revision_changed',
    );
    const reopened = new RemoteCommentary(join(dir, 'intent'));
    expect((await reopened.get()).preference).toEqual(manual.preference);
    const disabled = await reopened.set({ mode: 'disabled' }, manual.revision);
    expect((await new RemoteCommentary(join(dir, 'intent')).get()).preference).toEqual(
      disabled.preference,
    );
    expect(
      await reopened.discover(
        {
          call: async () => {
            await Promise.resolve();
            throw new Error('unexpected OBS call');
          },
        },
        disabled.revision,
        'probe',
      ),
    ).toEqual({ kind: 'manual' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('uses target settings and window properties, never source names, and cancels stale discovery', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'commentary-'));
  try {
    const owner = new RemoteCommentary(join(dir, 'intent'));
    const revision = (await owner.get()).revision;
    let windows: unknown[] = [];
    let settings: Record<string, unknown> = {};
    let changeDuringRead = false;
    const obs: ObsRpc = {
      call: async (type, data) => {
        if (type === 'GetVersion')
          return {
            availableRequests: [
              'GetInputList',
              'GetInputSettings',
              'GetInputPropertiesListPropertyItems',
            ],
          };
        if (type === 'GetInputList')
          return {
            inputs: [
              {
                inputUuid: 'probe',
                inputName: 'TeamSpeak',
                inputKind: 'wasapi_process_output_capture',
              },
            ],
          };
        if (type === 'GetInputSettings') return { inputSettings: settings };
        if (type === 'GetInputPropertiesListPropertyItems') {
          expect(data).toEqual({ inputUuid: 'probe', propertyName: 'window' });
          if (changeDuringRead) await owner.set({ mode: 'disabled' }, revision);
          return { propertyItems: windows };
        }
        throw new Error(type);
      },
    };
    expect((await owner.discover(obs, revision, 'probe')).kind).toBe('waiting');
    windows = [
      { itemName: 'TS', itemValue: 'Team#3ASpeak:Qt:ts3client_win64.exe', itemEnabled: true },
      { itemName: 'fake', itemValue: 'TeamSpeak:Qt:other.exe', itemEnabled: true },
    ];
    expect((await owner.discover(obs, revision, 'probe')).kind).toBe('window');
    windows.push({ itemName: 'TS6', itemValue: 'TeamSpeak:Qt:TeamSpeak.exe', itemEnabled: true });
    expect((await owner.discover(obs, revision, 'probe')).kind).toBe('windowChoices');
    settings = { window: 'TeamSpeak:Qt:TeamSpeak.exe' };
    expect((await owner.discover(obs, revision, 'probe')).kind).toBe('existing');
    settings = {};
    changeDuringRead = true;
    await expect(owner.discover(obs, revision, 'probe')).rejects.toThrow('revision_changed');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('creates a disabled probe only while idle and retains its UUID without a PID', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'commentary-'));
  try {
    let active = true;
    const calls: { type: string; data: Record<string, unknown> | undefined }[] = [];
    const obs: ObsRpc = {
      call: async (type, data) => {
        await Promise.resolve();
        calls.push({ type, data });
        if (type === 'GetStreamStatus') return { outputActive: active };
        if (type === 'GetRecordStatus') return { outputActive: false };
        if (type === 'GetSceneCollectionList') return { currentSceneCollectionName: 'Mizar' };
        if (type === 'GetVersion')
          return {
            availableRequests: [
              'CreateInput',
              'GetInputKindList',
              'GetInputPropertiesListPropertyItems',
            ],
          };
        if (type === 'GetInputKindList') return { inputKinds: ['wasapi_process_output_capture'] };
        if (type === 'CreateInput') return { inputUuid: 'owned-uuid' };
        if (type === 'GetInputList')
          return {
            inputs: [{ inputUuid: 'owned-uuid', inputKind: 'wasapi_process_output_capture' }],
          };
        throw new Error(type);
      },
    };
    const path = join(dir, 'journal');
    const context = { endpoint: 'local', collection: 'Mizar', sceneName: 'scene' };
    await expect(createCommentaryProbe(obs, path, context, async () => {})).rejects.toThrow(
      'output_active',
    );
    active = false;
    expect(await createCommentaryProbe(obs, path, context, async () => {})).toBe('owned-uuid');
    expect(calls.find((c) => c.type === 'CreateInput')?.data).toMatchObject({
      sceneItemEnabled: false,
      inputKind: 'wasapi_process_output_capture',
    });
    expect(await createCommentaryProbe(obs, path, context, async () => {})).toBe('owned-uuid');
    expect(calls.filter((c) => c.type === 'CreateInput')).toHaveLength(1);
    expect(await readFile(path, 'utf8')).not.toMatch(/pid/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
