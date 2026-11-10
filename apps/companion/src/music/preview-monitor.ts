import type { ObsRpc } from '../obs/reconcile.js';
import { findMusicInput } from './obs-provider.js';
import type { MusicState, MusicStore } from './store.js';

type Lease = MusicState['previewMonitorLeases'][number];
type Monitor = Lease['before'];
export type PreviewMonitorTarget = (obs: ObsRpc) => Promise<Lease['applied'] | null>;
const isMonitor = (value: unknown): value is Monitor =>
  value === 'OBS_MONITORING_TYPE_NONE' ||
  value === 'OBS_MONITORING_TYPE_MONITOR_ONLY' ||
  value === 'OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT';
const stopped = (state: unknown) =>
  [
    'OBS_MEDIA_STATE_STOPPED',
    'OBS_MEDIA_STATE_ENDED',
    'OBS_MEDIA_STATE_NONE',
    'OBS_MEDIA_STATE_ERROR',
  ].includes(String(state));
const same = (a: Lease | undefined, b: Lease) =>
  a?.uuid === b.uuid &&
  a.scope === b.scope &&
  a.before === b.before &&
  a.applied === b.applied &&
  a.phase === b.phase;

/** A single borrowed monitor field, persisted by the existing music owner. */
export class PreviewMonitor {
  constructor(
    private readonly store: MusicStore,
    private readonly target: PreviewMonitorTarget,
  ) {}
  private current(state = this.store.state): Lease | undefined {
    return state.previewMonitorLeases.find(
      (lease) => lease.uuid === state.sources.stinger && lease.scope === state.sourceScopes.stinger,
    );
  }
  owns(uuid: string): boolean {
    return this.current()?.uuid === uuid;
  }
  private identity(lease: Lease): boolean {
    return (
      this.store.state.sources.stinger === lease.uuid &&
      this.store.state.sourceScopes.stinger === lease.scope
    );
  }
  private async clear(lease: Lease, valid: () => boolean, external = false) {
    if (!valid()) return;
    await this.store.update((state) => {
      if (!valid() || !same(this.current(state), lease)) throw new Error('music_cancelled');
      state.previewMonitorLeases = state.previewMonitorLeases.filter((item) => !same(item, lease));
      if (external && this.identity(lease)) state.monitorConfigured.stinger = lease.uuid;
    });
  }
  private failure(stage: string, error: unknown) {
    this.store.previewEvent(`music_preview_monitor_${stage}`, { error });
  }
  /** An OBS mode readback is not evidence of sound at the listening device. */
  async observe(obs: ObsRpc, uuid: string, valid: () => boolean): Promise<boolean | null> {
    try {
      const mode = (await obs.call('GetInputAudioMonitorType', { inputUuid: uuid })).monitorType;
      if (!valid() || !isMonitor(mode)) return null;
      const lease = this.current();
      if (lease?.uuid === uuid && this.identity(lease) && mode !== lease.applied)
        await this.clear(lease, valid, true); // A later field edit is owned by the operator.
      return mode !== 'OBS_MONITORING_TYPE_NONE';
    } catch (error) {
      this.failure('read', error);
      return null;
    }
  }
  /** Only our borrowed field needs continuous device/recapture verification. */
  async safe(obs: ObsRpc, uuid: string, valid: () => boolean): Promise<boolean> {
    const lease = this.current();
    if (!lease || lease.uuid !== uuid) return true;
    try {
      const target = await this.target(obs);
      return valid() && this.identity(lease) && target === lease.applied;
    } catch {
      return false;
    }
  }
  async borrow(obs: ObsRpc, uuid: string, valid: () => boolean): Promise<void> {
    try {
      if (this.current()) return;
      const scope = this.store.state.sourceScopes.stinger;
      if (!scope || this.store.state.sources.stinger !== uuid || !valid()) return;
      const before = (await obs.call('GetInputAudioMonitorType', { inputUuid: uuid })).monitorType;
      // Existing enabled monitoring belongs to its owner, not to an audition.
      if (!valid() || before !== 'OBS_MONITORING_TYPE_NONE') return;
      // The audio owner proves device/recapture safety; this owner never changes tracks.
      const applied = await this.target(obs);
      if (!valid() || !applied) return;
      const lease: Lease = { uuid, scope, before, applied, phase: 'borrowed' };
      const current = () => valid() && this.identity(lease);
      if (
        !current() ||
        (await obs.ownershipScope?.()) !== scope ||
        (await obs.call('GetInputAudioMonitorType', { inputUuid: uuid })).monitorType !== before ||
        !current()
      )
        return;
      await this.store.update((state) => {
        if (!current() || this.current(state)) throw new Error('music_cancelled');
        state.previewMonitorLeases.push(lease);
      });
      const guard = () => {
        if (!current() || !same(this.current(), lease)) throw new Error('music_cancelled');
      };
      guard();
      const latest = (await obs.call('GetInputAudioMonitorType', { inputUuid: uuid })).monitorType;
      guard();
      if (!isMonitor(latest)) return;
      if (latest !== before) {
        await this.clear(lease, current, true);
        return;
      }
      if ((await this.target(obs)) !== applied) {
        await this.clear(lease, current);
        return;
      }
      guard();
      const writer = obs.withMutationGuard?.(guard) ?? obs;
      await writer.call('SetInputAudioMonitorType', { inputUuid: uuid, monitorType: applied });
      await this.observe(obs, uuid, current);
    } catch (error) {
      // Never replay an uncertain borrow. Media stop remains independent of this field.
      this.failure('borrow', error);
    }
  }
  async restore(obs: ObsRpc, valid: () => boolean): Promise<boolean> {
    const lease = this.current();
    if (!lease) return true;
    try {
      if (!valid() || !this.identity(lease)) return false;
      const name = await findMusicInput(obs, this.store, 'stinger', valid);
      if (!name || !valid() || (await obs.ownershipScope?.()) !== lease.scope) return false;
      const mode = (await obs.call('GetInputAudioMonitorType', { inputUuid: lease.uuid }))
        .monitorType;
      if (!valid() || !this.identity(lease) || !isMonitor(mode)) return false;
      if (mode !== lease.applied) {
        // Already restored, never applied, or externally edited: preserve the observed field.
        await this.clear(lease, valid, lease.phase !== 'restoring' || mode !== lease.before);
        return !this.current();
      }
      // A lost restore reply freezes only this monitor field, never playback/visual preparation.
      if (lease.phase === 'restoring') return false;
      // A restart can leave media playing with no in-memory audition. Never take its monitor.
      const media = await obs.call('GetMediaInputStatus', { inputUuid: lease.uuid });
      if (!valid() || !this.identity(lease) || !stopped(media.mediaState)) return false;
      const restoring: Lease = { ...lease, phase: 'restoring' };
      await this.store.update((state) => {
        if (!valid() || !this.identity(lease) || !same(this.current(state), lease))
          throw new Error('music_cancelled');
        const index = state.previewMonitorLeases.findIndex((item) => same(item, lease));
        state.previewMonitorLeases[index] = restoring;
      });
      const guard = () => {
        if (!valid() || !this.identity(restoring) || !same(this.current(), restoring))
          throw new Error('music_cancelled');
      };
      let dispatched = false;
      try {
        guard();
        // Persistence can wait behind another music update. Recheck before the actual write.
        const [latest, playback] = await Promise.all([
          obs.call('GetInputAudioMonitorType', { inputUuid: lease.uuid }),
          obs.call('GetMediaInputStatus', { inputUuid: lease.uuid }),
        ]);
        guard();
        if (!isMonitor(latest.monitorType)) throw new Error('music_monitor_unconfirmed');
        if (latest.monitorType !== lease.applied) {
          await this.clear(restoring, valid, latest.monitorType !== lease.before);
          return !this.current();
        }
        if (!stopped(playback.mediaState)) throw new Error('music_preview_monitor_busy');
        dispatched = !obs.reportsDispatch;
        await (obs.withMutationGuard?.(guard) ?? obs).call(
          'SetInputAudioMonitorType',
          { inputUuid: lease.uuid, monitorType: lease.before },
          () => {
            dispatched = true;
          },
        );
      } catch (error) {
        if (!dispatched)
          await this.store.update((state) => {
            const index = state.previewMonitorLeases.findIndex((item) => same(item, restoring));
            if (index >= 0) state.previewMonitorLeases[index] = lease;
          });
        throw error;
      }
      if (!valid()) return false;
      const read = (await obs.call('GetInputAudioMonitorType', { inputUuid: lease.uuid }))
        .monitorType;
      if (!valid() || !isMonitor(read) || read === lease.applied) return false;
      await this.clear(restoring, valid, read !== lease.before);
      return !this.current();
    } catch (error) {
      this.failure('restore', error);
      return false;
    }
  }
}
