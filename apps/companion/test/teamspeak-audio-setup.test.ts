import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('../src/obs/remote-commentary-setup.js', () => ({
  prepareRemoteCommentary: async (...args: unknown[]) => {
    (args[7] as (uuid: string, revision: string) => void)('ts', 'revision');
    return [];
  },
}));
vi.mock('../src/obs/managed-audio.js', () => ({ reconcileManagedAudio: vi.fn() }));
import { configureIndependentAudio } from '../src/obs/audio-setup.js';
import { reconcileManagedAudio } from '../src/obs/managed-audio.js';
import type { ObsRpc } from '../src/obs/reconcile.js';
import type { RemoteCommentary } from '../src/obs/remote-commentary.js';

const dirs: string[] = [];
afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

it('retains the desktop path for automatically discovered modern TeamSpeak', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mizar-ts-setup-'));
  dirs.push(dir);
  const calls: string[] = [];
  const obs: ObsRpc = {
    async call(type) {
      calls.push(type);
      if (type === 'GetInputSettings')
        return { inputSettings: { window: 'TeamSpeak:Qt:teamspeak.exe' } };
      throw new Error(`unexpected ${type}`);
    },
  };
  const owner = {
    get: async () => ({ revision: 'revision', preference: { mode: 'autoTeamspeak' } }),
  } as unknown as RemoteCommentary;
  const findings = await configureIndependentAudio(
    obs,
    'ws://127.0.0.1:4455',
    { subscribe: () => () => {} },
    owner,
    join(dir, 'journal'),
    'http://127.0.0.1:3000',
  );
  expect(findings[0]?.code).toBe('audio_teamspeak_compatibility');
  expect(calls).toEqual(['GetInputSettings']);
  expect(reconcileManagedAudio).not.toHaveBeenCalled();
});

it('keeps an existing independent binding and reports the compatibility risk', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mizar-ts-setup-'));
  dirs.push(dir);
  const obs: ObsRpc = {
    async call(type) {
      if (type === 'GetInputSettings')
        return { inputSettings: { window: 'TeamSpeak:Qt:teamspeak.exe' } };
      throw new Error(`unexpected ${type}`);
    },
  };
  const owner = {
    get: async () => ({ revision: 'revision', preference: { mode: 'autoTeamspeak' } }),
  } as unknown as RemoteCommentary;
  const findings = await configureIndependentAudio(
    obs,
    'ws://127.0.0.1:4455',
    { subscribe: () => () => {} },
    owner,
    join(dir, 'journal'),
    'http://127.0.0.1:3000',
    undefined,
    undefined,
    undefined,
    async () => ({
      revision: 'routing',
      ids: { game: 'game', remoteCommentary: 'ts', microphone: 'mic' },
    }),
  );
  expect(reconcileManagedAudio).toHaveBeenCalledOnce();
  expect(findings[0]?.code).toBe('audio_teamspeak_compatibility');
});
