import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { GameAudioController } from '../src/obs/audio-policy-controller.js';
import { ObsAudioRouting } from '../src/obs/audio-routing.js';
import { ObsConfigStore } from '../src/obs/config.js';

it('cannot release a held lease during halftime and reapply attenuation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'game-audio-'));
  const controller = new GameAudioController(
    new ObsAudioRouting(join(dir, 'routing')),
    new ObsConfigStore(join(dir, 'obs')),
    join(dir, 'policy'),
  );
  try {
    const leasePath = join(dir, 'policy.lease');
    await writeFile(
      leasePath,
      JSON.stringify({
        operation: '00000000-0000-4000-8000-000000000001',
        binding: {
          inputUuid: 'game',
          inputKind: 'wasapi_process_output_capture',
          collection: 'A',
          endpoint: 'ws://127.0.0.1:4455',
        },
        revision: 'revision',
        epoch: 1,
        field: 'volume',
        before: 0.5,
        applied: 0.25,
        phase: 'held',
      }),
    );
    await controller.load();
    const revision = controller.status().revision;
    await controller.configure({ mode: 'keep' }, revision);
    await expect(controller.configure({ mode: 'mute' }, revision)).rejects.toThrow(
      'audio_policy_stale',
    );
    controller.tick('halftime');
    await expect(controller.releaseHeld(controller.status().revision)).rejects.toThrow(
      'audio_policy_wait_for_gameplay',
    );
    expect(JSON.parse(await readFile(leasePath, 'utf8')).phase).toBe('held');
  } finally {
    controller.close();
    await rm(dir, { recursive: true, force: true });
  }
});
