import { desiredMusicMonitorMode } from './cues.js';
import type { MusicDevice } from './device.js';
import type { MusicStore } from './store.js';

/** Manages ephemeral stinger monitor mode for auditions using the single monitor preference rule. */
export class PreviewMonitor {
  constructor(private readonly store: MusicStore) {}

  private failure(stage: string, error: unknown) {
    this.store.previewEvent(`music_preview_monitor_${stage}`, { error });
  }

  /** Enable monitor-and-output on stinger before audition playback and verify readback is not off. */
  async enable(obs: MusicDevice, uuid: string, valid: () => boolean): Promise<boolean> {
    try {
      await obs.setMonitorMode({ sourceId: uuid, mode: 'monitor-and-output' });
      if (!valid()) return false;
      const mode = await obs.monitorMode({ sourceId: uuid });
      if (!valid()) return false;
      return mode !== undefined && mode !== 'off';
    } catch (error) {
      this.failure('enable', error);
      return false;
    }
  }

  /** An OBS mode readback is not evidence of sound at the listening device. */
  async observe(obs: MusicDevice, uuid: string, valid: () => boolean): Promise<boolean | null> {
    try {
      const mode = await obs.monitorMode({ sourceId: uuid });
      if (!valid() || mode === undefined) return null;
      return mode !== 'off';
    } catch (error) {
      this.failure('read', error);
      return null;
    }
  }

  /** Sync stinger monitor mode back to store.state.monitorPreference after audition ends. */
  async syncPreference(obs: MusicDevice, valid: () => boolean): Promise<boolean> {
    const uuid = this.store.state.sources.stinger;
    if (!uuid || !valid()) return true;
    try {
      const name = await obs.hasSource(this.store, 'stinger', valid);
      if (!name || !valid()) return false;
      const desired = desiredMusicMonitorMode(this.store.state.monitorPreference === true);
      const current = await obs.monitorMode({ sourceId: uuid });
      if (!valid()) return false;
      if (current === desired) return true;
      await obs.setMonitorMode({ sourceId: uuid, mode: desired });
      if (!valid()) return false;
      const read = await obs.monitorMode({ sourceId: uuid });
      return valid() && read === desired;
    } catch (error) {
      this.failure('restore', error);
      return false;
    }
  }
}
