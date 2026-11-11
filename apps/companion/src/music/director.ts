import { RepeatedDiagnostic } from '../support/repeated-diagnostic.js';
import { diagnosticValue } from '../support/session-journal.js';
import { musicFailure } from './failure.js';
import { randomUUID } from 'node:crypto';
import type {
  MusicGroup,
  MusicStatus,
  MusicTrack,
  MusicPreviewRequest,
} from '@mizar/protocol/music';
import { musicOpeningScope, type MusicOpeningScope } from '../scope/identities.js';
import type {
  MonitorRelationship,
  MusicAudioMode,
  MusicDevice,
  MusicDeviceProvider,
  MusicLayer,
  MusicMediaState,
  MusicMonitorChange,
  MusicMonitorMode,
  MusicMonitorOriginals,
  MusicMonitorPlan,
  MusicMixerControl,
} from './device.js';
import {
  readMonitorOriginal,
  readMonitorOriginals,
  writeMonitorOriginal,
  writeMonitorOriginals,
} from './monitor-journal.js';
import {
  musicCue,
  musicMapKey,
  musicPause,
  musicSafe,
  type MusicCue,
  type MusicTruth,
} from './cues.js';
import { looping, type MusicStore, type Playback } from './store.js';
import { MusicPreview } from './preview.js';
function desiredMusicMonitorMode(
  relationship: MonitorRelationship,
  wanted: boolean,
): MusicMonitorMode {
  if (!wanted || relationship === 'unknown') return 'off';
  return relationship === 'same' ? 'monitor-only' : 'monitor-and-output';
}
function ownedMonitorApplied(original: MusicMonitorOriginals['bgm']): MusicMonitorMode | undefined {
  if (!original) return undefined;
  // v1.9.1 stored the pre-mix mode before changing it to monitor-only.
  return original.applied ?? (original.mode === 'monitor-and-output' ? 'monitor-only' : undefined);
}
function monitorRestoreTarget(
  original: MusicMonitorOriginals['bgm'],
  preference: boolean | null,
): MusicMonitorMode | undefined {
  if (!original) return undefined;
  return !original.applied && preference === false ? 'off' : original.mode;
}
function observedPlayback(state: MusicMediaState): MusicStatus['playback'] {
  if (state === 'playing') return 'playing';
  if (state === 'paused') return 'paused';
  if (state === 'stopped' || state === 'ended') return 'stopped';
  return 'unknown';
}

function tailVolume(
  track: MusicTrack,
  cursor: number | null,
  duration: number | null,
  volume: number,
  fadeOutMs: number,
) {
  if (cursor === null || fadeOutMs <= 0) return volume;
  const end = Math.min(
    track.endMs ?? Infinity,
    duration !== null && duration > 0 ? duration : Infinity,
  );
  if (!Number.isFinite(end)) return volume;
  return volume * Math.min(1, Math.max(0, (end - cursor) / fadeOutMs));
}

interface Fade {
  sourceId: string;
  from: number;
  to: number;
  at: number;
  ms: number;
  stop: boolean;
}
export class MusicDirector implements MusicAudioMode, MusicMixerControl {
  private readonly preview: MusicPreview;
  private generation = 0;
  private commandRevision = 0;
  private desiredKey = '';
  private inFlight = false;
  private closed = false;
  private readonly operationFailures = new RepeatedDiagnostic((stage, evidence) =>
    this.store.previewEvent(stage, evidence),
  );
  private heldOverride: boolean | null = null;
  private holdReasonOverride: 'external' | 'stop' | null = null;
  private pendingOpening: {
    key: string;
    expires: number;
    scope: MusicOpeningScope;
    track?: MusicTrack;
  } | null = null;
  private fades: Partial<Record<MusicLayer, Fade>> = {};
  private expectedStops = new Map<MusicLayer, string>();
  private appliedVolumes = new Map<MusicLayer, number>();
  private failed = new Map<string, Set<string>>();
  private status: MusicStatus = {
    held: false,
    connection: 'idle',
    message: null,
    bgm: null,
    stinger: null,
    playback: 'unknown',
    intent: 'automatic',
    cursorMs: null,
    durationMs: null,
    segmentStartMs: null,
    segmentEndMs: null,
    monitor: 'unknown',
  };
  private epoch = 0;
  private monitorSettingsChanged = false;
  private lastPoll = -Infinity;
  private nextRequested = false;
  private manual: {
    cue: MusicCue;
    paused: boolean;
    pausedAt: number | null;
    epoch: number | null;
  } | null = null;
  private unknownControl = false;
  private resumeLayers = new Set<MusicLayer>();
  constructor(
    readonly store: MusicStore,
    private readonly provider: MusicDeviceProvider,
    private readonly truth: () => MusicTruth,
    private readonly now = Date.now,
    private readonly random = Math.random,
    private readonly audioModePending: () => Promise<boolean> = () => Promise.resolve(false),
  ) {
    this.preview = new MusicPreview(store, now, async (obs) => {
      if (await this.audioModePending().catch(() => true)) return null;
      if (!(await obs.monitorSafe().catch(() => false))) return null;
      const relationship = await obs.monitorRelationship().catch(() => 'unknown' as const);
      const desired = desiredMusicMonitorMode(relationship, true);
      return desired === 'off' ? null : desired;
    });
  }
  /** Explicit operator preparation; reads and playback never enter this structural path. */
  async prepare(
    valid: () => boolean = () => true,
    session: (run: (device: MusicDevice) => Promise<void>) => Promise<void> = (run) =>
      this.provider.session(run),
  ): Promise<void> {
    if (!this.store.ready || this.store.failure) throw new Error('music_unavailable');
    await this.withAudioModeRecovery(async (current) => {
      const active = () => valid() && current();
      const needsLayer = (layer: MusicLayer) =>
        Object.entries(this.store.state.config.groups).some(
          ([group, config]) =>
            config.tracks.length > 0 && (layer === 'stinger' || group !== 'opening'),
        );
      const failures: unknown[] = [];
      await session(async (obs) => {
        for (const layer of ['bgm', 'stinger'] as const) {
          if (!active()) throw new Error('music_cancelled');
          if (
            !needsLayer(layer) &&
            !this.store.state.sources[layer] &&
            !this.store.state.sourceInitialization.some((item) => item.layer === layer)
          )
            continue;
          try {
            if (
              readMonitorOriginal(this.store.state.desktopMonitorOriginal[layer]) &&
              (await this.audioModePending().catch(() => true)) &&
              !(await obs.hasSource(this.store, layer, active))
            )
              throw new Error('music_monitor_source_changed');
            await obs.prepareResources(this.store, layer, active);
          } catch (error) {
            failures.push(error);
          }
        }
      });
      if (failures.length) throw new AggregateError(failures, 'music_preparation_incomplete');
    });
  }
  private isHeld() {
    return this.heldOverride ?? this.store.state.held;
  }
  private isExternalHold() {
    return (
      this.isHeld() &&
      (this.holdReasonOverride ?? this.store.state.holdReason ?? 'external') === 'external'
    );
  }
  private isStingerHeld() {
    return (
      Boolean(this.store.state.stingerHeld) &&
      !(this.isHeld() && (this.holdReasonOverride ?? this.store.state.holdReason) === 'stop')
    );
  }
  private effectiveVolume(group: MusicGroup, track: MusicTrack) {
    const state = this.store.state;
    const spec = state.config.groups[group];
    const entry = track.entryId
      ? spec.tracks.find((item) => item.entryId === track.entryId)
      : undefined;
    return (state.muted ? 0 : state.master) * ((entry ? entry.gain : track.gain) ?? spec.volume);
  }
  get(): MusicStatus {
    return {
      ...this.status,
      message:
        this.status.message ??
        (!this.preview.busy && this.preview.recoveryPending
          ? '上次试听的本机监听恢复未确认，请在 OBS 核对音效来源的播放和监听设置。'
          : null),
      held: this.isHeld(),
      stingerHeld: Boolean(this.isStingerHeld()),
      intent: this.isHeld() ? 'held' : this.manual ? 'manual' : 'automatic',
      ...(this.preview.status ? { preview: this.preview.status } : {}),
    };
  }
  /** Explicit controls only touch media/mixer fields, never route or monitor fields. */
  private async immediateControl(
    current: () => boolean,
    run: (obs: MusicDevice, layer: MusicLayer, uuid: string) => Promise<void>,
  ): Promise<void> {
    const deadline = Date.now() + 4000;
    while (this.inFlight && current() && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 10));
    if (!current()) throw new Error('music_cancelled');
    if (this.inFlight) throw new Error('music_control_pending');
    this.inFlight = true;
    try {
      await this.provider.session(async (obs) => {
        let failure: unknown;
        for (const layer of ['bgm', 'stinger'] as const) {
          try {
            const name = await obs.hasSource(this.store, layer, current);
            if (!current()) throw new Error('music_cancelled');
            const uuid = this.store.state.sources[layer];
            if (name && uuid) await run(obs, layer, uuid);
          } catch (error) {
            failure ??= error;
          }
        }
        if (failure) throw failure;
      });
      if (!current()) throw new Error('music_cancelled');
      this.status.connection = 'connected';
      this.status.message = null;
    } catch (error) {
      if (current()) {
        this.status.playback = 'unknown';
        this.status.message = '音乐控制未确认，请检查 OBS 后重试。';
      }
      throw error;
    } finally {
      this.inFlight = false;
    }
  }
  private async stopMedia(obs: MusicDevice, layer: MusicLayer, uuid: string, valid: () => boolean) {
    if (!valid()) throw new Error('music_cancelled');
    this.expectedStops.set(layer, uuid);
    await obs.controlMedia({
      sourceId: uuid,
      action: 'stop',
    });
    if (!valid()) throw new Error('music_cancelled');
    const read = await obs.mediaStatus({ sourceId: uuid });
    if (!valid()) throw new Error('music_cancelled');
    if (!['stopped', 'ended', 'empty'].includes(read.state))
      throw new Error('music_stop_unconfirmed');
    if (layer === 'stinger') this.preview.confirmStopped(uuid);
    this.expectedStops.delete(layer);
  }
  async setMixer(volume?: number, muted?: boolean): Promise<boolean> {
    if (this.closed || !this.store.ready || this.store.failure)
      throw new Error('music_unavailable');
    const revision = ++this.commandRevision;
    const current = () => !this.closed && revision === this.commandRevision;
    this.invalidate();
    await this.store.update((state) => {
      if (volume !== undefined) state.master = volume;
      if (muted !== undefined) state.muted = muted;
    });
    await this.immediateControl(current, async (obs, layer, uuid) => {
      // WASAPI monitoring does not honor source mute. Apply the effective gain
      // first, including mute-only requests and unmuting after a zero-gain mute.
      const saved = this.store.state[layer];
      const target =
        this.preview.mixerVolume(uuid) ??
        (saved
          ? this.effectiveVolume(saved.group, saved.track)
          : this.store.state.muted
            ? 0
            : this.store.state.master);
      await this.preview.prepareMixer(obs, uuid, target);
      if (!current()) throw new Error('music_cancelled');
      await obs.setVolume({ sourceId: uuid, gain: target });
      if (!current()) throw new Error('music_cancelled');
      const readVolume = await obs.volume({ sourceId: uuid });
      if (typeof readVolume !== 'number' || Math.abs(readVolume - target) > 0.001)
        throw new Error('music_volume_unconfirmed');
      this.appliedVolumes.set(layer, target);
      this.preview.confirmMixer(uuid, target);
      if (muted !== undefined) {
        await this.preview.prepareMixer(obs, uuid, undefined, muted);
        if (!current()) throw new Error('music_cancelled');
        await obs.setMute({ sourceId: uuid, muted: muted });
        if (!current()) throw new Error('music_cancelled');
        const read = await obs.mute({ sourceId: uuid });
        if (read !== muted) throw new Error('music_mute_unconfirmed');
        this.preview.confirmMixer(uuid, undefined, muted);
      }
    });
    return true;
  }
  async previewRequest(request: MusicPreviewRequest) {
    if (this.closed) throw new Error('music_preview_closed');
    if (request.action === 'start' && (this.isExternalHold() || this.isStingerHeld()))
      throw new Error('music_preview_channel_busy');
    if (
      request.action === 'start' &&
      (this.pendingOpening || (this.store.state.stinger && !this.store.state.stinger.finished))
    )
      throw new Error('music_preview_channel_busy');
    this.preview.submit(request);
    while (this.inFlight && !this.closed) await new Promise((resolve) => setTimeout(resolve, 10));
    this.lastPoll = -Infinity;
    await this.tick();
  }
  invalidate() {
    this.generation++;
    this.desiredKey = '';
  }
  async command(action: 'stop' | 'resume' | 'next') {
    if (this.closed) return;
    if (action === 'next' && this.manual) {
      const group = this.manual.cue.group;
      if (!looping(group)) throw new Error('music_next_invalid');
      const track = this.choose(group, this.manual.cue.key, this.manual.cue.track, true);
      if (!track) throw new Error('music_track_invalid');
      await this.manualPlay(group, track.id, track.entryId);
      return;
    }
    this.preview.cancel(action === 'stop' ? 'explicit_stop' : 'operator_command');
    if (action !== 'next') {
      this.manual = null;
      this.unknownControl = false;
    }
    const revision = ++this.commandRevision;
    const current = () => !this.closed && revision === this.commandRevision;
    this.invalidate(); // Cancel playback work; command validity is independent of telemetry changes.
    this.fades = {};
    this.pendingOpening = null;
    this.resumeLayers.clear();
    this.nextRequested = false;
    let persistenceError: unknown;
    if (action !== 'next') {
      // Resume stays quiet until both persistence steps confirm this is still the newest command.
      this.heldOverride = true;
      this.holdReasonOverride = action === 'stop' ? 'stop' : 'external';
      try {
        await this.store.hold(action === 'stop', 'stop');
        if (!current()) return;
        if (action === 'resume') {
          await this.store.update((s) => {
            if (current() && s.bgm && !s.bgm.finished) s.bgm.suspended = true;
          });
          if (!current()) return;
          this.resumeLayers = new Set(
            (['bgm', 'stinger'] as const).filter(
              (layer) => this.store.state.sources[layer] !== null,
            ),
          );
          this.failed.clear();
          this.appliedVolumes.clear();
          this.heldOverride = false;
          this.holdReasonOverride = null;
        }
      } catch (error) {
        if (!current()) return;
        this.heldOverride = true;
        persistenceError = error;
        if (action === 'resume') {
          await this.store.hold(true).catch(() => undefined);
          if (!current()) return;
        }
      }
    } else if (!this.isHeld()) this.nextRequested = true;
    if (!current()) return;
    if (action === 'stop') {
      await this.immediateControl(current, (obs, layer, uuid) =>
        this.stopMedia(obs, layer, uuid, current),
      );
      if (current()) this.status.playback = 'stopped';
    } else await this.tick();
    if (!current()) return;
    if (persistenceError)
      throw new Error('music_hold_persistence_failed', { cause: persistenceError });
  }
  /** Formal playback has no browser lease. Newer commands invalidate pending work. */
  async manualPlay(group: MusicGroup, trackId: string | undefined, entryId?: string) {
    if (this.closed || !this.store.ready || this.store.failure)
      throw new Error('music_unavailable');
    const matches = this.store.state.config.groups[group].tracks.filter((item) =>
      entryId === undefined
        ? item.id === trackId
        : item.entryId === entryId && (trackId === undefined || item.id === trackId),
    );
    const track = matches.length === 1 ? matches[0] : undefined;
    if (!track || group === 'opening') throw new Error('music_track_invalid');
    const preserveStinger = this.isExternalHold() || Boolean(this.isStingerHeld());
    const revision = ++this.commandRevision;
    this.unknownControl = false;
    this.invalidate();
    this.preview.cancel('formal_cue');
    this.pendingOpening = null;
    this.fades = {};
    this.heldOverride = true;
    await this.store.hold(false, 'external', preserveStinger);
    if (revision !== this.commandRevision || this.closed) return;
    this.heldOverride = false;
    this.holdReasonOverride = null;
    this.resumeLayers = new Set(this.store.state.sources.bgm ? ['bgm'] : []);
    this.manual = {
      cue: { group, key: `manual:${randomUUID()}`, track },
      paused: false,
      pausedAt: null,
      epoch: null,
    };
    while (this.inFlight && revision === this.commandRevision && !this.closed)
      await new Promise((resolve) => setTimeout(resolve, 10));
    if (revision !== this.commandRevision || this.closed) return;
    this.lastPoll = -Infinity;
    await this.tick();
    if (this.status.connection !== 'connected' || !this.manual)
      throw new Error('music_play_unconfirmed');
  }
  async manualPause(paused: boolean) {
    const manual = this.manual;
    if (!manual || this.closed) throw new Error('music_manual_inactive');
    const revision = ++this.commandRevision;
    this.invalidate();
    while (this.inFlight && revision === this.commandRevision && !this.closed)
      await new Promise((resolve) => setTimeout(resolve, 10));
    const current = () =>
      !this.closed && revision === this.commandRevision && this.manual === manual;
    if (!current()) return;
    this.inFlight = true;
    try {
      await this.provider.session(async (obs, epoch) => {
        if (!current() || manual.epoch !== epoch) throw new Error('music_cancelled');
        const name = await obs.hasSource(this.store, 'bgm', current);
        const uuid = this.store.state.sources.bgm;
        if (!name || !uuid || !current()) throw new Error('music_source_missing');
        const settings = await obs.mediaFile({ sourceId: uuid });
        const path = await this.store.trackPath(manual.cue.track!.id);
        if (!current() || settings !== path) throw new Error('music_source_changed');
        const before = await obs.mediaStatus({ sourceId: uuid });
        const mute = await obs.mute({ sourceId: uuid });
        const volume = await obs.volume({ sourceId: uuid });
        if (current() && this.manualControlObserved('bgm', before.state, mute, volume)) {
          await this.holdForObsControl();
          throw new Error('music_source_changed');
        }
        if (!current() || before.state !== (paused ? 'playing' : 'paused'))
          throw new Error('music_state_changed');
        const actionAt = this.now();
        manual.paused = paused;
        await obs.controlMedia({
          sourceId: uuid,
          action: paused ? 'pause' : 'play',
        });
        if (!current()) return;
        let after = await obs.mediaStatus({ sourceId: uuid });
        // OBS may acknowledge the command before its media thread reports the
        // new state. Only wait while the previous state is still observable;
        // never resend the command or overwrite another observed state.
        for (let attempt = 0; attempt < 10 && after.state === before.state; attempt++) {
          if (!current()) return;
          await new Promise((resolve) => setTimeout(resolve, 50));
          if (!current()) return;
          after = await obs.mediaStatus({ sourceId: uuid });
        }
        if (!current()) return;
        this.status.playback = observedPlayback(after.state);
        if (after.state !== (paused ? 'paused' : 'playing'))
          throw new Error('music_state_unconfirmed');
        if (paused) manual.pausedAt = actionAt;
        else {
          const fade = this.fades.bgm;
          if (fade && !fade.stop && manual.pausedAt !== null)
            fade.at += Math.max(0, this.now() - manual.pausedAt);
          manual.pausedAt = null;
        }
      });
    } catch (error) {
      if (current()) {
        this.status.playback = 'unknown';
        await this.provider
          .session(async (obs) => {
            const name = await obs.hasSource(this.store, 'bgm', current);
            if (name && current()) {
              const read = await obs.mediaStatus({
                sourceId: this.store.state.sources.bgm,
              });
              if (current()) this.status.playback = observedPlayback(read.state);
            }
          })
          .catch(() => undefined);
        if (current()) {
          this.manual = null;
          this.unknownControl = true;
          this.heldOverride = true;
          this.holdReasonOverride = 'external';
          await this.store.hold(true).catch(() => undefined);
        }
      }
      throw error;
    } finally {
      this.inFlight = false;
    }
  }
  async seek(cursorMs: number, playbackId: string) {
    if (!Number.isInteger(cursorMs) || cursorMs < 0 || this.closed)
      throw new Error('music_seek_invalid');
    const saved = this.store.state.bgm;
    if (!saved || saved.key !== playbackId || saved.finished || saved.suspended || this.isHeld())
      throw new Error('music_seek_unavailable');
    const revision = ++this.commandRevision;
    this.invalidate();
    while (this.inFlight && revision === this.commandRevision && !this.closed)
      await new Promise((resolve) => setTimeout(resolve, 10));
    const current = () =>
      !this.closed && revision === this.commandRevision && this.store.state.bgm?.key === saved.key;
    if (!current()) throw new Error('music_cancelled');
    this.inFlight = true;
    let writing = false;
    try {
      await this.provider.session(async (obs, epoch) => {
        if (epoch !== this.epoch || !current()) throw new Error('music_cancelled');
        const name = await obs.hasSource(this.store, 'bgm', current);
        const uuid = this.store.state.sources.bgm;
        if (!name || !uuid || !current()) throw new Error('music_source_missing');
        const settings = await obs.mediaFile({ sourceId: uuid });
        const path = await this.store.trackPath(saved.track.id);
        if (!current()) throw new Error('music_cancelled');
        if (settings !== path) {
          this.unknownControl = true;
          await this.holdForObsControl();
          throw new Error('music_source_changed');
        }
        const media = await obs.mediaStatus({ sourceId: uuid });
        const mute = await obs.mute({ sourceId: uuid });
        const volume = await obs.volume({ sourceId: uuid });
        if (current() && this.manualControlObserved('bgm', media.state, mute, volume)) {
          await this.holdForObsControl();
          throw new Error('music_source_changed');
        }
        const duration = media.durationMs;
        const end = Math.min(saved.track.endMs ?? Infinity, duration ?? Infinity);
        if (!current() || !['playing', 'paused'].includes(media.state))
          throw new Error('music_seek_unavailable');
        if (duration === null || duration <= 0 || cursorMs < saved.track.startMs || cursorMs >= end)
          throw new Error('music_seek_invalid');
        writing = true;
        await obs.setMediaCursor({ sourceId: uuid, cursorMs: cursorMs });
        if (!current()) return;
        const observed = await obs.mediaStatus({ sourceId: uuid });
        if (!current()) return;
        this.status.cursorMs = observed.cursorMs;
        this.status.durationMs = observed.durationMs;
        if (this.status.cursorMs === null) throw new Error('music_seek_unconfirmed');
        delete this.fades.bgm;
        const spec = this.store.state.config.groups[saved.group];
        const target = tailVolume(
          saved.track,
          this.status.cursorMs,
          this.status.durationMs ?? duration,
          this.effectiveVolume(saved.group, saved.track),
          spec.fadeOutMs,
        );
        if (!current()) return;
        await obs.setVolume({ sourceId: uuid, gain: target });
        if (current()) this.appliedVolumes.set('bgm', target);
      });
    } catch (error) {
      if (writing && current()) {
        await this.provider
          .session(async (obs) => {
            const name = await obs.hasSource(this.store, 'bgm', current);
            if (name && current()) {
              const read = await obs.mediaStatus({
                sourceId: this.store.state.sources.bgm,
              });
              if (current()) this.status.cursorMs = read.cursorMs;
              const volume = await obs.volume({
                sourceId: this.store.state.sources.bgm,
              });
              if (current() && typeof volume === 'number' && Number.isFinite(volume))
                this.appliedVolumes.set('bgm', volume);
            }
          })
          .catch(() => {
            if (current()) this.status.cursorMs = null;
          });
        if (current()) {
          this.status.playback = 'unknown';
          this.manual = null;
          this.unknownControl = true;
          this.heldOverride = true;
          this.holdReasonOverride = 'external';
          await this.store.hold(true).catch(() => undefined);
        }
      }
      throw error;
    } finally {
      this.inFlight = false;
    }
  }

  private async readMonitor(obs: MusicDevice, valid: () => boolean) {
    const modes: (MusicMonitorMode | undefined)[] = [];
    for (const layer of ['bgm', 'stinger'] as const) {
      const name = await obs.hasSource(this.store, layer, valid);
      if (!valid()) return;
      if (!name) continue;
      const read = await obs.monitorMode({
        sourceId: this.store.state.sources[layer],
      });
      if (!valid()) return;
      modes.push(read);
    }
    this.status.monitor =
      modes.length === 0 || modes.includes(undefined)
        ? 'unknown'
        : modes.every((mode) => mode === 'off')
          ? 'disabled'
          : modes.every((mode) => mode !== 'off')
            ? 'enabled'
            : 'mixed';
  }

  noteMonitorSettingsChanged() {
    this.monitorSettingsChanged = true;
  }

  private async configureDefaultMonitor(obs: MusicDevice, valid: () => boolean, recheck = false) {
    if (await this.audioModePending().catch(() => true)) return;
    if (!valid()) return;
    const wanted = this.store.state.monitorPreference;
    const pending = (['bgm', 'stinger'] as const).filter((layer) => {
      if (layer === 'stinger' && (this.isStingerHeld() || this.preview.busy)) return false;
      const uuid = this.store.state.sources[layer];
      return uuid && this.store.state.monitorConfigured[layer] !== uuid;
    });
    if (!pending.length && !recheck) return;
    const relationship = await obs.monitorRelationship().catch(() => 'unknown' as const);
    if (!valid()) return;
    this.status.monitorPending = wanted === true && relationship === 'unknown';
    if (wanted === null) return;
    const safe = await obs.monitorSafe().catch(() => false);
    if (!valid()) return;
    if (!safe) {
      this.status.monitorPending = wanted;
      return;
    }
    for (const layer of ['bgm', 'stinger'] as const) {
      if (layer === 'stinger' && (this.isStingerHeld() || this.preview.busy)) continue;
      const uuid = this.store.state.sources[layer];
      if (uuid && this.preview.ownsMonitor(uuid)) continue;
      const original = readMonitorOriginal(this.store.state.desktopMonitorOriginal[layer]);
      const isNew = pending.includes(layer);
      if (!uuid || (!isNew && (!recheck || !original))) continue;
      const name = await obs.hasSource(this.store, layer, valid);
      if (!name || !valid()) return;
      const observed = await obs.monitorMode({ sourceId: uuid });
      if (observed === undefined || !valid()) return;
      if (
        !(await obs.monitorSafe().catch(() => false)) ||
        (await obs.monitorRelationship().catch(() => 'unknown' as const)) !== relationship
      ) {
        if (valid()) this.status.monitorPending = wanted;
        return;
      }
      const desired = desiredMusicMonitorMode(relationship, wanted);
      if (
        isNew && !original
          ? observed !== 'off' && observed !== desired
          : !original || original.sourceId !== uuid || ownedMonitorApplied(original) !== observed
      ) {
        // An external edit owns this field; leave it unchanged.
        this.status.monitorPending = wanted;
        continue;
      }
      await this.store.update((state) => {
        state.monitorConfigured[layer] = uuid;
        if (relationship !== 'independent')
          state.desktopMonitorOriginal[layer] = writeMonitorOriginal({
            sourceId: uuid,
            mode: monitorRestoreTarget(original, wanted) ?? (wanted ? 'monitor-and-output' : 'off'),
            applied: desired,
          });
      });
      if (!valid()) return;
      if (observed !== desired) {
        await obs.setMonitorMode({ sourceId: uuid, mode: desired });
        if ((await obs.monitorMode({ sourceId: uuid })) !== desired)
          throw new Error('music_monitor_unconfirmed');
      }
    }
  }

  /** Hold music changes while the audio mode journal owns monitor writes. */
  async prepareDesktopMix<T>(
    obs: MusicDevice,
    relationship: MonitorRelationship,
    apply: (plan: MusicMonitorPlan) => Promise<T>,
  ): Promise<T> {
    return this.withAudioModeRecovery(async (current) => {
      if (!this.store.ready || this.store.failure) {
        // Basic routing can proceed without a music library only when it needs
        // no music monitor writes. Never substitute default state for a failed read.
        for (const mode of await obs.readManagedMonitorModes()) {
          const unchangedSafe =
            mode === 'off' ||
            (relationship === 'same' && mode === 'monitor-only') ||
            ((relationship === 'different' || relationship === 'independent') &&
              mode === 'monitor-and-output');
          if (!unchangedSafe) throw new Error('music_monitor_unavailable');
        }
        if (!current()) throw new Error('music_cancelled');
        return apply({
          changes: [],
          managedSources: [],
          musicBefore: { bgm: null, stinger: null },
          musicAfter: { bgm: null, stinger: null },
        });
      }
      if (this.preview.busy) {
        this.preview.cancel('audio_mode');
        await this.reconcilePreview(obs, this.epoch, current);
      }
      await this.preview.recoverMonitor(obs, current);
      const changes: MusicMonitorChange[] = [];
      const managedSources: string[] = [];
      const musicBefore = readMonitorOriginals(this.store.state.desktopMonitorOriginal);
      const originals: Partial<
        Record<MusicLayer, NonNullable<MusicMonitorOriginals[MusicLayer]> | null>
      > = {};
      for (const layer of ['bgm', 'stinger'] as const) {
        const name = await obs.hasSource(this.store, layer, current);
        const uuid = this.store.state.sources[layer];
        const original = readMonitorOriginal(this.store.state.desktopMonitorOriginal[layer]);
        if (!name || !uuid) {
          if (original) throw new Error('music_monitor_source_changed');
          continue;
        }
        const mode = await obs.monitorMode({ sourceId: uuid });
        if (mode === undefined) throw new Error('music_monitor_unknown');
        const auditionOwnsMonitor = this.preview.ownsMonitor(uuid);
        managedSources.push(uuid);
        if (original && original.sourceId !== uuid) throw new Error('music_monitor_source_changed');
        const held = ownedMonitorApplied(original);
        if (original && (held === undefined || held !== mode)) {
          // A later external edit owns this field; do not replay the backup.
          originals[layer] = null;
          continue;
        }
        if (relationship === 'independent') {
          const target = monitorRestoreTarget(original, this.store.state.monitorPreference);
          if (auditionOwnsMonitor) {
            if (target && mode !== target) throw new Error('music_preview_monitor_pending');
            continue;
          }
          if (target && mode !== target)
            changes.push({
              sourceId: uuid,
              before: mode,
              applied: target,
            });
          if (original) originals[layer] = null;
          continue;
        }
        const wanted = this.store.state.monitorPreference === true;
        const desired = desiredMusicMonitorMode(relationship, wanted);
        if (auditionOwnsMonitor) {
          if (mode !== desired) throw new Error('music_preview_monitor_pending');
          continue;
        }
        if (mode !== desired) changes.push({ sourceId: uuid, before: mode, applied: desired });
        originals[layer] = {
          sourceId: uuid,
          mode: monitorRestoreTarget(original, this.store.state.monitorPreference) ?? mode,
          applied: desired,
        };
      }
      if (!current()) throw new Error('music_cancelled');
      const musicAfter = structuredClone(musicBefore);
      for (const layer of ['bgm', 'stinger'] as const)
        if (originals[layer] !== undefined) musicAfter[layer] = originals[layer]!;
      const result = await apply({ changes, managedSources, musicBefore, musicAfter });
      this.status.monitorPending =
        relationship === 'unknown' && this.store.state.monitorPreference === true;
      return result;
    });
  }
  mixerStatus(): ReturnType<MusicMixerControl['mixerStatus']> {
    const status = this.get();
    const { state, ready } = this.store;
    return {
      desktopIncludesMusic:
        this.wantsMonitor() &&
        (['bgm', 'stinger'] as const).some(
          (layer) =>
            readMonitorOriginal(state.desktopMonitorOriginal[layer])?.applied === 'monitor-only',
        ),
      channel: {
        name: '音乐',
        volume: ready ? state.master : null,
        muted: ready ? state.muted : null,
        control: !ready
          ? 'unknown'
          : status.held
            ? 'held'
            : status.connection === 'unavailable'
              ? 'unknown'
              : 'available',
      },
    };
  }
  wantsMonitor(): boolean {
    return this.store.state.monitorPreference === true;
  }
  monitorPlanCompatible(relationship: MonitorRelationship, after: MusicMonitorOriginals): boolean {
    if ((!this.store.ready || this.store.failure) && Object.values(after).some(Boolean))
      return false;
    const desired = desiredMusicMonitorMode(
      relationship,
      this.store.state.monitorPreference === true,
    );
    return (['bgm', 'stinger'] as const).every(
      (layer) => !after[layer]?.applied || after[layer]!.applied === desired,
    );
  }
  async withAudioModeRecovery<T>(run: (current: () => boolean) => Promise<T>): Promise<T> {
    if (this.closed) throw new Error('music_unavailable');
    const revision = ++this.commandRevision;
    this.invalidate();
    while (this.inFlight && revision === this.commandRevision && !this.closed)
      await new Promise((resolve) => setTimeout(resolve, 10));
    if (this.closed || revision !== this.commandRevision) throw new Error('music_cancelled');
    this.inFlight = true;
    try {
      return await run(() => !this.closed && revision === this.commandRevision);
    } finally {
      this.inFlight = false;
    }
  }
  async commitDesktopMonitorOriginals(
    before: MusicMonitorOriginals,
    after: MusicMonitorOriginals,
    side: 'before' | 'after',
  ) {
    if (
      ['bgm', 'stinger'].every(
        (layer) => !before[layer as MusicLayer] && !after[layer as MusicLayer],
      )
    )
      return;
    if (this.closed || !this.store.ready || this.store.failure)
      throw new Error('music_unavailable');
    await this.store.update((state) => {
      for (const layer of ['bgm', 'stinger'] as const) {
        const current = readMonitorOriginal(state.desktopMonitorOriginal[layer]);
        const equal = (a: typeof current, b: typeof current) =>
          JSON.stringify(a) === JSON.stringify(b);
        if (!equal(current, before[layer]) && !equal(current, after[layer]))
          throw new Error(`music_monitor_conflict:${layer}`);
        for (const value of [before[layer], after[layer]])
          if (value && state.sources[layer] !== value.sourceId)
            throw new Error(`music_monitor_source_changed:${layer}`);
      }
      state.desktopMonitorOriginal = writeMonitorOriginals(side === 'before' ? before : after);
    });
  }
  async monitor(enabled: boolean) {
    if (await this.audioModePending()) throw new Error('audio_mode_pending');
    if (this.closed || !this.store.ready || this.store.failure)
      throw new Error('music_unavailable');
    const revision = ++this.commandRevision;
    this.invalidate();
    while (this.inFlight && revision === this.commandRevision && !this.closed)
      await new Promise((resolve) => setTimeout(resolve, 10));
    const current = () => !this.closed && revision === this.commandRevision;
    if (!current()) return;
    if (await this.audioModePending()) throw new Error('audio_mode_pending');
    this.inFlight = true;
    this.preview.cancel('monitor_control');
    this.status.monitor = 'unknown';
    try {
      await this.store.update((state) => {
        if (current()) state.monitorPreference = enabled;
      });
      if (!current()) return;
      await this.provider.session(async (obs) => {
        await this.reconcilePreview(obs, this.epoch, current);
        const monitorRecovered = await this.preview.recoverMonitor(obs, current);
        let pending = false;
        let found = false;
        const relation = await obs.monitorRelationship().catch(() => 'unknown' as const);
        const monitorPending = enabled && relation === 'unknown';
        for (const layer of ['bgm', 'stinger'] as const) {
          const name = await obs.hasSource(this.store, layer, current);
          const uuid = this.store.state.sources[layer];
          if (!current()) throw new Error('music_cancelled');
          if (!name || !uuid) continue;
          if (!monitorRecovered && this.preview.ownsMonitor(uuid)) {
            pending = true;
            continue;
          }
          found = true;
          const monitorType = desiredMusicMonitorMode(relation, enabled);
          await this.store.update((state) => {
            state.monitorConfigured[layer] = uuid;
            state.desktopMonitorOriginal[layer] =
              relation === 'independent'
                ? null
                : writeMonitorOriginal({
                    sourceId: uuid,
                    mode: enabled ? 'monitor-and-output' : 'off',
                    applied: monitorType,
                  });
          });
          if (!current()) return;
          await obs.setMonitorMode({
            sourceId: uuid,
            mode: monitorType,
          });
          if (!current()) return;
          const read = await obs.monitorMode({ sourceId: uuid });
          if (!current()) return;
          if (read !== monitorType) throw new Error('music_monitor_unconfirmed');
        }
        if (pending) throw new Error('music_preview_monitor_pending');
        if (!found) throw new Error('music_source_missing');
        if (current()) {
          this.status.monitor = monitorPending ? 'unknown' : enabled ? 'enabled' : 'disabled';
          this.status.monitorPending = monitorPending;
        }
      });
    } catch (error) {
      if (current()) {
        this.status.monitor = 'unknown';
        await this.provider.session((obs) => this.readMonitor(obs, current)).catch(() => undefined);
      }
      throw error;
    } finally {
      this.inFlight = false;
    }
  }
  /** Only called by an actual, current Take start. Never reconstructed from scene snapshots. */
  opening(key: string, track?: MusicTrack) {
    const t = this.truth();
    if (
      this.closed ||
      this.isHeld() ||
      this.manual ||
      this.isStingerHeld() ||
      !t.production ||
      !musicSafe(t.program) ||
      t.program.status.telemetry !== 'fresh'
    )
      return;
    if (this.store.state.consumed.includes(key)) return;
    this.preview.cancel('opening_take');
    this.pendingOpening = {
      key,
      expires: this.now() + 1000,
      scope: musicOpeningScope(this.truth().program),
      ...(track ? { track } : {}),
    };
  }
  private choose(group: MusicGroup, key: string, previous?: MusicTrack, manual = false) {
    const spec = this.store.state.config.groups[group];
    const tracks = spec.tracks.filter((t) => !this.failed.get(key)?.has(t.id));
    if ((!manual && !spec.enabled) || !tracks.length) return null;
    if (!looping(group)) return tracks[0]!;
    if (spec.order === 'shuffle') {
      const candidates =
        tracks.length > 1
          ? tracks.filter((t) =>
              previous?.entryId ? t.entryId !== previous.entryId : t !== previous,
            )
          : tracks;
      const pool = candidates.length ? candidates : tracks;
      return pool[Math.floor(this.random() * pool.length)]!;
    }
    return tracks[
      (tracks.findIndex((t) =>
        previous?.entryId ? t.entryId === previous.entryId : t.id === previous?.id,
      ) +
        1) %
        tracks.length
    ]!;
  }
  private async reconcilePreview(
    obs: MusicDevice,
    epoch: number,
    valid: () => boolean,
    safe = false,
  ) {
    const previewOwned = this.preview.busy;
    await this.preview.reconcile(
      obs,
      epoch,
      valid,
      safe,
      (uuid) => this.expectedStops.set('stinger', uuid),
      () => this.holdForPreviewControl(valid),
    );
    if (previewOwned && !this.preview.busy) this.expectedStops.delete('stinger');
  }
  async tick(): Promise<void> {
    if (this.closed) return;
    // Route recovery defers automatic playback, never an already-started audition's stop.
    const automaticDeferred =
      (await this.audioModePending().catch(() => true)) &&
      !this.manual &&
      !(this.isHeld() && !this.isExternalHold());
    if (this.closed) return;
    if (automaticDeferred && !this.preview.busy && !this.preview.recoveryPending) return;
    if (this.store.failure && this.preview.busy) this.preview.cancel('storage_unavailable');
    if (this.store.failure && !this.preview.busy) {
      this.status.failure = 'load_failed';
      this.status.playback = 'unknown';
      this.status.message = '本机音乐配置无法读取，音乐已停用。请保留原文件并检查本机配置。';
      return;
    }
    if (!this.store.ready && !this.preview.busy) return;
    const truth = this.truth();
    const map = musicMapKey(truth.program);
    const pause =
      musicSafe(truth.program) &&
      truth.program.status.telemetry === 'fresh' &&
      musicPause(truth.program);
    // Invalidate synchronously even while an OBS request is awaiting its reply.
    const preliminary = JSON.stringify([
      truth.production,
      musicOpeningScope(this.truth().program),
      musicSafe(truth.program),
      truth.program.status.telemetry,
      map,
      truth.program.map.phase,
      truth.program.clock?.phase,
      (truth.program.clock?.endsInSeconds ?? 999) <= 5,
      truth.active,
      this.isHeld(),
      this.store.automaticEnabled,
      this.store.state.config,
      this.store.state.master,
      this.store.state.muted,
    ]);
    const changed = preliminary !== this.desiredKey;
    if (changed) {
      this.desiredKey = preliminary;
      this.generation++;
    }
    if (this.inFlight) return;
    // Facts still invalidate every 100 ms; steady media polling is bounded, fades remain smooth.
    const interval = Object.keys(this.fades).length || this.preview.busy ? 100 : 250;
    if (!changed && !this.pendingOpening && this.now() - this.lastPoll < interval) return;
    this.lastPoll = this.now();
    this.inFlight = true;
    const generation = this.generation;
    const valid = () => !this.closed && generation === this.generation;
    try {
      if (automaticDeferred || this.store.failure || !this.store.ready) {
        await this.provider.session(async (obs, epoch) => {
          await this.reconcilePreview(obs, epoch, valid);
          if (valid()) {
            this.status.connection = 'connected';
            this.status.failure = null;
            this.status.message = null;
          }
        });
        return;
      }
      if (pause && this.store.state.pause?.map !== map)
        await this.store.update((s) => {
          s.pause = { map, id: randomUUID() };
        });
      else if (!pause && truth.program.status.telemetry === 'fresh' && this.store.state.pause)
        await this.store.update((s) => {
          s.pause = null;
        });
      let cue = musicCue(truth, this.store.state.pause?.id ?? null);
      const current = this.store.state.bgm;
      if (
        cue?.group === 'waiting' &&
        truth.program.map.phase === 'gameover' &&
        current?.group === 'mapVictory' &&
        !current.finished &&
        current.key === `mapVictory:${map}`
      )
        cue = { group: current.group, key: current.key };
      if (cue?.group === 'mapVictory' && truth.active === 'intermap' && current?.key !== cue.key)
        cue = { group: 'waiting', key: `waiting:${truth.program.match!.matchId}` };
      // Labels inside one pause do not create a new theme or restart its media.
      if (cue?.key.startsWith('pause:') && current?.key === cue.key)
        cue = { ...cue, group: current.group };
      if (cue?.group === 'mapVictory' && current?.key === cue.key && current.finished)
        cue = { group: 'waiting', key: `waiting:${truth.program.match!.matchId}` };
      // Once a result has completed, returning to that presentation cannot replay it.
      if (cue && this.store.state.consumed.includes(cue.key))
        cue =
          cue.group === 'mapVictory'
            ? { group: 'waiting', key: `waiting:${truth.program.match!.matchId}` }
            : null;
      if (!this.store.automaticEnabled) cue = null;
      if (this.manual) cue = this.manual.cue;
      if (this.isHeld()) cue = null;
      const opening = this.store.automaticEnabled ? this.pendingOpening : null;
      this.pendingOpening = null;
      const hasSources = Object.values(this.store.state.sources).some(Boolean);
      const configured =
        cue &&
        (this.manual || this.store.state.config.groups[cue.group].enabled) &&
        this.store.state.config.groups[cue.group].tracks.length;
      if (!hasSources && !configured && !opening && !this.preview.busy) {
        this.status.connection = 'idle';
        return;
      }
      await this.provider.session(async (obs, epoch) => {
        const reconnect = this.epoch !== epoch;
        if (this.manual && this.manual.epoch !== null && this.manual.epoch !== epoch) {
          this.manual = null;
          this.unknownControl = true;
          this.heldOverride = true;
          this.holdReasonOverride = 'external';
          await this.store.hold(true);
          cue = null;
        }
        if (!valid()) return;
        if (this.manual) this.manual.epoch = epoch;
        this.epoch = epoch;
        this.status.connection = 'connected';
        this.status.failure = null;
        this.status.message = null;
        await this.preview.recoverMonitor(obs, valid);
        if (!valid()) return;
        if (this.isExternalHold()) {
          await this.observeHeldPlayback(obs, valid);
          if (valid()) await this.readMonitor(obs, valid);
          if (this.unknownControl && valid())
            this.status.message = '音乐控制未确认，请在 OBS 核对后停止音乐或恢复自动。';
          return;
        }
        const previewOwned = this.preview.busy;
        if (configured || opening) this.preview.programPriority();
        const p = this.truth().program;
        const previewSafe =
          !this.pendingOpening &&
          !opening &&
          (p.map.phase !== 'live' ||
            Boolean(musicCue(this.truth(), this.store.state.pause?.id ?? null))) &&
          (p.map.phase === null || (musicSafe(p) && p.status.telemetry === 'fresh'));
        await this.reconcilePreview(obs, epoch, valid, previewSafe);
        const monitorRecheck = reconnect || this.monitorSettingsChanged;
        this.monitorSettingsChanged = false;
        await this.configureDefaultMonitor(obs, valid, monitorRecheck);
        if (valid() && this.preview.busy) await this.readMonitor(obs, valid);
        if (!valid() || this.preview.busy) return;
        if (this.unknownControl) {
          const name = await obs.hasSource(this.store, 'bgm', valid);
          if (name && valid()) {
            const media = await obs.mediaStatus({
              sourceId: this.store.state.sources.bgm,
            });
            this.status.playback = observedPlayback(media.state);
          }
          this.status.message = '音乐控制未确认，请在 OBS 核对后停止音乐或恢复自动。';
          return;
        }
        // Observe both existing layers before changing a cue or attributing a stop to the system.
        if (await this.observeManualControls(obs, valid, previewOwned)) return;
        await this.layer(obs, 'bgm', cue, valid);
        await this.configureDefaultMonitor(obs, valid);
        if (this.store.state.sources.bgm || this.store.state.sources.stinger)
          await this.readMonitor(obs, valid);
        if (
          opening &&
          opening.scope === musicOpeningScope(this.truth().program) &&
          opening.expires >= this.now() &&
          valid() &&
          !this.isHeld()
        ) {
          await this.store.consume(opening.key); // At-most-once across uncertain RPCs / process restarts.
          await this.layer(
            obs,
            'stinger',
            {
              group: 'opening',
              key: opening.key,
              scope: opening.scope,
              ...(opening.track ? { track: opening.track } : {}),
            },
            valid,
          );
        } else if (!previewOwned && !this.isStingerHeld()) {
          const stinger = this.store.state.stinger;
          const safe =
            !this.manual &&
            truth.production &&
            musicSafe(truth.program) &&
            truth.program.status.telemetry === 'fresh' &&
            !this.isHeld();
          await this.layer(
            obs,
            'stinger',
            safe &&
              stinger &&
              !stinger.finished &&
              (!stinger.scope || stinger.scope === musicOpeningScope(this.truth().program))
              ? { group: 'opening', key: stinger.key, track: stinger.track }
              : null,
            valid,
          );
        }
        await this.configureDefaultMonitor(obs, valid);
        if (valid()) await this.readMonitor(obs, valid);
      });
      if (valid()) this.operationFailures.clear('music_operation_recovered');
    } catch (error) {
      if (!(error instanceof Error && error.message === 'music_cancelled'))
        this.preview.unavailable(error);
      if (valid()) {
        const failure = musicFailure(error);
        try {
          const diagnostic = diagnosticValue(error);
          this.operationFailures.record(
            'music_operation_failed',
            JSON.stringify([this.desiredKey, this.epoch, failure.code, diagnostic]),
            { error: diagnostic, code: failure.code },
          );
        } catch {
          // Preserve the original failure path even when diagnostics cannot be serialized.
          this.store.previewEvent('music_operation_failed', { error, code: failure.code });
        }
        this.status.failure = failure.code;
        this.status.connection = failure.code === 'obs_disconnected' ? 'unavailable' : 'connected';
        if (this.manual) {
          this.manual = null;
          this.unknownControl = true;
          this.heldOverride = true;
          this.holdReasonOverride = 'external';
          await this.store.hold(true).catch(() => undefined);
        }
        if (!valid()) return;
        this.status.playback = 'unknown';
        this.status.cursorMs = null;
        this.status.durationMs = null;
        this.status.monitor = 'unknown';
        this.status.message =
          error instanceof Error && error.message === 'music_cancelled' ? null : failure.message;
      }
    } finally {
      this.inFlight = false;
    }
  }
  private manualControlObserved(
    layer: MusicLayer,
    state: MusicMediaState,
    muted: boolean | undefined,
    volume: number | undefined,
  ) {
    if (this.isHeld() || this.resumeLayers.has(layer)) return false;
    const saved = this.store.state[layer];
    if ((saved?.finished || saved?.suspended) && ['stopped', 'ended', 'empty'].includes(state))
      this.expectedStops.delete(layer);
    const active = ['playing', 'opening', 'buffering'].includes(state);
    const expectedVolume =
      this.appliedVolumes.get(layer) ??
      (saved ? this.effectiveVolume(saved.group, saved.track) : null);
    return (
      // A registered source or a monitor receipt is not an active formal playback grant.
      (active &&
        (!saved || saved.finished) &&
        this.expectedStops.get(layer) !== this.store.state.sources[layer]) ||
      (muted === true && !this.store.state.muted) ||
      Boolean(layer === 'bgm' && this.manual?.paused && state === 'playing') ||
      (state === 'paused' && !(layer === 'bgm' && this.manual?.paused)) ||
      Boolean(
        saved &&
        !saved.finished &&
        !saved.suspended &&
        ((state === 'stopped' &&
          this.expectedStops.get(layer) !== this.store.state.sources[layer]) ||
          (active && expectedVolume !== null && Math.abs(Number(volume) - expectedVolume) > 0.015)),
      )
    );
  }
  private async holdForObsControl() {
    this.commandRevision++;
    this.manual = null;
    this.preview.cancel('manual_control');
    this.heldOverride = true;
    this.holdReasonOverride = 'external';
    this.pendingOpening = null;
    this.fades = {};
    this.nextRequested = false;
    this.resumeLayers.clear();
    this.invalidate();
    await this.store.hold(true);
  }
  private async holdForPreviewControl(valid: () => boolean) {
    if (!valid()) return;
    if (!this.manual) return this.holdForObsControl();
    await this.store.update((state) => {
      if (valid()) state.stingerHeld = true;
    });
  }
  private async observeHeldPlayback(obs: MusicDevice, valid: () => boolean) {
    this.status.stinger = null;
    const name = await obs.hasSource(this.store, 'bgm', valid);
    if (!valid()) return;
    if (!name) {
      this.status.playback = 'unknown';
      this.status.bgm = null;
      this.status.cursorMs = null;
      this.status.durationMs = null;
      this.status.segmentStartMs = null;
      this.status.segmentEndMs = null;
    } else {
      const args = { sourceId: this.store.state.sources.bgm };
      const [media, volume, mute, settings] = await Promise.all([
        obs.mediaStatus(args),
        obs.volume(args),
        obs.mute(args),
        obs.mediaFile(args),
      ]);
      if (!valid()) return;
      this.status.playback = observedPlayback(media.state);
      this.status.cursorMs = media.cursorMs;
      this.status.durationMs = media.durationMs;
      const saved = this.store.state.bgm;
      const path = saved ? await this.store.trackPath(saved.track.id).catch(() => null) : null;
      if (!valid()) return;
      const matches = path && settings === path;
      this.status.bgm =
        saved && matches && !saved.finished
          ? {
              group: saved.group,
              track: saved.track.name,
              playbackId: saved.key,
              volume:
                mute === true
                  ? 0
                  : typeof volume === 'number' && Number.isFinite(volume)
                    ? Math.min(1, Math.max(0, volume))
                    : this.effectiveVolume(saved.group, saved.track),
            }
          : null;
      this.status.segmentStartMs = this.status.bgm ? saved!.track.startMs : null;
      this.status.segmentEndMs = this.status.bgm ? saved!.track.endMs : null;
    }
    const stinger = this.store.state.stinger;
    if (stinger && !stinger.finished) {
      const stingerName = await obs.hasSource(this.store, 'stinger', valid);
      if (stingerName && valid()) {
        const stingerArgs = { sourceId: this.store.state.sources.stinger };
        const [stingerMedia, stingerSettings, stingerPath] = await Promise.all([
          obs.mediaStatus(stingerArgs),
          obs.mediaFile(stingerArgs),
          this.store.trackPath(stinger.track.id).catch(() => null),
        ]);
        if (!valid()) return;
        if (
          stingerPath &&
          stingerSettings === stingerPath &&
          ['playing', 'paused'].includes(observedPlayback(stingerMedia.state))
        )
          this.status.stinger = stinger.track.name;
      }
    }
  }
  private async observeManualControls(obs: MusicDevice, valid: () => boolean, skipStinger = false) {
    if (this.isHeld()) return false;
    for (const layer of ['bgm', 'stinger'] as const) {
      if ((skipStinger || this.isStingerHeld()) && layer === 'stinger') continue;
      if (!this.store.state.sources[layer] || this.resumeLayers.has(layer)) continue;
      const name = await obs.hasSource(this.store, layer, valid);
      if (!name) continue;
      const args = { sourceId: this.store.state.sources[layer] };
      const device = obs.checkCalls(() => {
        if (!valid()) throw new Error('music_cancelled');
      });
      const [media, mute, volume] = await Promise.all([
        device.mediaStatus(args),
        device.mute(args),
        device.volume(args),
      ]);
      if (!valid()) throw new Error('music_cancelled');
      if (layer === 'bgm') this.status.playback = observedPlayback(media.state);
      if (this.manualControlObserved(layer, media.state, mute, volume)) {
        await this.holdForObsControl();
        return true;
      }
    }
    return false;
  }
  private async waitAfterRestart(
    obs: MusicDevice,
    layer: MusicLayer,
    sourceId: string,
    cursorMs: number,
    valid: () => boolean,
  ) {
    const deadline = Date.now() + 2000;
    while (valid()) {
      const media = await obs.mediaStatus({ sourceId });
      const mute = await obs.mute({ sourceId });
      if (!valid()) throw new Error('music_cancelled');
      if ((mute === true && !this.store.state.muted) || media.state === 'paused') {
        await this.holdForObsControl();
        return false;
      }
      if (media.state === 'playing') {
        const volume = await obs.volume({ sourceId });
        if (!valid()) throw new Error('music_cancelled');
        if (this.manualControlObserved(layer, media.state, false, volume)) {
          await this.holdForObsControl();
          return false;
        }
        if (cursorMs) await obs.setMediaCursor({ sourceId, cursorMs: cursorMs });
        return true;
      }
      if (Date.now() >= deadline) throw new Error('music_media_start_timeout');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('music_cancelled');
  }
  private async layer(
    obs: MusicDevice,
    layer: MusicLayer,
    cue: MusicCue | null,
    valid: () => boolean,
  ) {
    const device = obs.checkCalls(() => {
      if (!valid()) throw new Error('music_cancelled');
    });
    const controlMedia: MusicDevice['controlMedia'] = (data) => {
      if (!valid()) throw new Error('music_cancelled');
      if (data.action === 'stop') this.expectedStops.set(layer, String(data.sourceId));
      else if (data.action === 'restart') this.expectedStops.delete(layer);
      return obs.controlMedia(data);
    };
    let saved = this.store.state[layer];
    const spec = cue ? this.store.state.config.groups[cue.group] : null;
    const enabled = Boolean(
      cue && (this.manual?.cue === cue || spec?.enabled) && (cue.track || spec?.tracks.length),
    );
    const name = await obs.hasSource(this.store, layer, valid);
    if (!name) {
      if (enabled) throw new Error('music_source_missing');
      return;
    }
    if (enabled) await obs.verifyPlayback(this.store, layer, valid);
    saved = this.store.state[layer];
    const args = { sourceId: this.store.state.sources[layer]! };
    const media = await device.mediaStatus(args);
    let mute = await device.mute(args);
    const volume = await device.volume(args);
    const settings = await device.mediaFile(args);
    const resuming = this.resumeLayers.has(layer);
    if (resuming) {
      await device.setMute({ ...args, muted: false });
      this.resumeLayers.delete(layer);
      mute = false;
    }
    const state = media.state;
    if (layer === 'bgm') {
      this.status.playback = observedPlayback(state);
      this.status.cursorMs = media.cursorMs;
      this.status.durationMs = media.durationMs;
      this.status.segmentStartMs = saved?.track.startMs ?? null;
      this.status.segmentEndMs = saved?.track.endMs ?? null;
    }
    const active = state === 'playing' || state === 'opening' || state === 'buffering';
    const markStatus = (p: Playback | null) => {
      if (layer === 'bgm')
        this.status.bgm =
          p && !p.finished
            ? {
                group: p.group,
                track: p.track.name,
                playbackId: p.key,
                volume: this.effectiveVolume(p.group, p.track),
              }
            : null;
      else this.status.stinger = p && !p.finished ? p.track.name : null;
    };
    if (!resuming && this.manualControlObserved(layer, state, mute, volume)) {
      await this.holdForObsControl();
      markStatus(null);
      return;
    }
    if (!enabled) {
      // Gameplay/stale/manual stop bypass ordinary fades. No delayed work can delay a cut.
      delete this.fades[layer];
      if (active || state === 'paused')
        await controlMedia({
          ...args,
          action: 'stop',
        });
      if (saved && !saved.suspended)
        await this.store.update((s) => {
          const finished =
            layer === 'stinger' ||
            (this.truth().program.status.telemetry === 'fresh' &&
              this.truth().program.map.phase === 'live' &&
              ['mapVictory', 'matchVictory'].includes(saved!.group));
          if (finished)
            s.consumed = [
              ...new Set([...s.consumed.filter((key) => key !== saved!.key), saved!.key]),
            ].slice(-64);
          s[layer] = {
            ...saved!,
            finished: saved!.finished || finished,
            suspended: true,
            cursorMs: Math.max(0, Number(media.cursorMs) || 0),
          };
        });
      markStatus(null);
      return;
    }
    const matching =
      saved?.key === cue!.key &&
      saved.group === cue!.group &&
      (cue!.track ? [cue!.track] : spec!.tracks).some(
        (t) =>
          (t.entryId && saved!.track.entryId
            ? t.entryId === saved!.track.entryId
            : t.id === saved!.track.id) &&
          t.startMs === saved!.track.startMs &&
          t.endMs === saved!.track.endMs,
      );
    if (matching && saved!.finished) {
      if (active)
        await controlMedia({
          ...args,
          action: 'stop',
        });
      markStatus(null);
      return;
    }
    if (matching && saved) {
      const targetVolume = this.effectiveVolume(saved.group, saved.track);
      const file = settings;
      const expectedPath = await this.store.trackPath(saved.track.id).catch(() => null);
      if (!expectedPath || file !== expectedPath) {
        if (active)
          await controlMedia({
            ...args,
            action: 'stop',
          });
        await this.fail(layer, saved);
        return;
      }
      if (layer === 'bgm' && this.manual?.paused && state === 'paused') {
        const fade = this.fades[layer];
        const progress =
          fade && !fade.stop && fade.ms
            ? Math.min(1, Math.max(0, ((this.manual.pausedAt ?? this.now()) - fade.at) / fade.ms))
            : 1;
        const faded =
          fade && !fade.stop
            ? targetVolume * (fade.from + (fade.to - fade.from) * progress)
            : targetVolume;
        const target = Math.min(
          faded,
          tailVolume(saved.track, media.cursorMs, media.durationMs, targetVolume, spec!.fadeOutMs),
        );
        if (Math.abs(target - Number(volume)) > 0.0001) {
          await device.setVolume({ ...args, gain: target });
          this.appliedVolumes.set(layer, target);
        }
        markStatus(saved);
        return;
      }
      if (saved.suspended) {
        await this.store.update((s) => {
          s[layer] = { ...saved!, suspended: false };
        });
        if (active) {
          await device.setVolume({ ...args, gain: targetVolume });
          this.appliedVolumes.set(layer, targetVolume);
        }
        if (!active) {
          await device.setVolume({
            ...args,
            gain: spec!.fadeInMs ? 0 : targetVolume,
          });
          this.appliedVolumes.set(layer, spec!.fadeInMs ? 0 : targetVolume);
          await controlMedia({
            ...args,
            action: 'restart',
          });
          if (!(await this.waitAfterRestart(obs, layer, args.sourceId, saved.cursorMs, valid)))
            return;
          this.fades[layer] = {
            sourceId: args.sourceId,
            from: spec!.fadeInMs ? 0 : 1,
            to: 1,
            at: this.now(),
            ms: spec!.fadeInMs,
            stop: false,
          };
        }
        markStatus(saved);
        return;
      }
      const segmentEnded =
        saved.track.endMs !== null && Number(media.cursorMs) >= saved.track.endMs;
      if (state === 'error' || state === 'empty') {
        await this.fail(layer, saved);
        return;
      }
      if (state === 'ended' || segmentEnded || (layer === 'bgm' && this.nextRequested)) {
        this.nextRequested = false;
        if (segmentEnded || active)
          await controlMedia({
            ...args,
            action: 'stop',
          });
        if (!looping(saved.group)) {
          await this.store.update((s) => {
            s[layer] = { ...saved!, finished: true };
            s.consumed = [
              ...new Set([...s.consumed.filter((key) => key !== saved!.key), saved!.key]),
            ].slice(-64);
          });
          delete this.fades[layer];
          markStatus(null);
          return;
        }
      } else if (active) {
        // Tail gain follows the observed media cursor, not elapsed wall time. Seeking and
        // pausing therefore cannot keep an obsolete fade-out timer alive.
        const fade = this.fades[layer];
        let gain = targetVolume;
        if (fade && !fade.stop) {
          const progress = fade.ms ? Math.min(1, Math.max(0, (this.now() - fade.at) / fade.ms)) : 1;
          gain = targetVolume * (fade.from + (fade.to - fade.from) * progress);
          if (progress === 1) delete this.fades[layer];
        } else if (fade?.stop) delete this.fades[layer];
        gain = Math.min(
          gain,
          tailVolume(saved.track, media.cursorMs, media.durationMs, targetVolume, spec!.fadeOutMs),
        );
        if (valid() && Math.abs(gain - Number(volume)) > 0.0001)
          await device.setVolume({ ...args, gain: gain });
        if (valid()) this.appliedVolumes.set(layer, gain);
        markStatus(saved);
        return; // Reconcile an existing source without Restart or seek.
      } else return;
    }
    // Ordinary BGM changes fade out incrementally. They never block polling or emergency stop.
    if (!matching && active && saved && layer === 'bgm') {
      const oldSpec = this.store.state.config.groups[saved.group];
      const fade = this.fades[layer];
      if (!fade?.stop)
        this.fades[layer] = {
          sourceId: args.sourceId,
          from:
            this.effectiveVolume(saved.group, saved.track) > 0
              ? Number(volume) / this.effectiveVolume(saved.group, saved.track)
              : 1,
          to: 0,
          at: this.now(),
          ms: oldSpec.fadeOutMs,
          stop: true,
        };
      if (await this.fade(obs, layer, valid)) return;
    }
    const track =
      cue!.track ?? this.choose(cue!.group, cue!.key, matching ? saved?.track : undefined);
    if (!track) {
      this.status.message = '本组曲目均无法播放，保持静音。请检查音频文件或重新选曲。';
      markStatus(null);
      return;
    }
    const targetVolume = this.effectiveVolume(cue!.group, track);
    const path = await this.store.trackPath(track.id).catch(() => null);
    if (!path) {
      saved = {
        group: cue!.group,
        key: cue!.key,
        ...(cue!.scope ? { scope: cue!.scope } : {}),
        track,
        configRevision: this.store.state.configRevision,
        finished: false,
        suspended: false,
        cursorMs: track.startMs,
      };
      await this.fail(layer, saved);
      return;
    }
    saved = {
      group: cue!.group,
      key: cue!.key,
      ...(cue!.scope ? { scope: cue!.scope } : {}),
      track,
      configRevision: this.store.state.configRevision,
      finished: false,
      suspended: true,
      cursorMs: track.startMs,
    };
    // Persist intent before issuing a start; on restart a one-shot is only reconciled, never replayed.
    await this.store.update((s) => {
      s[layer] = saved;
    });
    if (!valid()) return;
    await controlMedia({
      ...args,
      action: 'stop',
    });
    await device.setVolume({ ...args, gain: spec!.fadeInMs ? 0 : targetVolume });
    this.appliedVolumes.set(layer, spec!.fadeInMs ? 0 : targetVolume);
    await device.loadMedia({ ...args, path });
    // An identical file does not reliably autostart after STOP in OBS.
    await controlMedia({
      ...args,
      action: 'restart',
    });
    if (!(await this.waitAfterRestart(obs, layer, args.sourceId, track.startMs, valid))) return;
    await this.store.update((s) => {
      if (s[layer]?.key === saved.key && s[layer]?.track.id === saved.track.id)
        s[layer] = { ...saved, suspended: false };
    });
    this.fades[layer] = {
      sourceId: args.sourceId,
      from: spec!.fadeInMs ? 0 : 1,
      to: 1,
      at: this.now(),
      ms: spec!.fadeInMs,
      stop: false,
    };
    markStatus(saved);
    if (layer === 'bgm' && valid()) {
      const observed = await device.mediaStatus(args);
      this.status.playback = observedPlayback(observed.state);
      this.status.cursorMs = observed.cursorMs;
      this.status.durationMs = observed.durationMs;
      this.status.segmentStartMs = saved.track.startMs;
      this.status.segmentEndMs = saved.track.endMs;
    }
  }
  private async fail(layer: MusicLayer, saved: Playback) {
    const failed = this.failed.get(saved.key) ?? new Set<string>();
    failed.add(saved.track.id);
    this.failed.set(saved.key, failed);
    while (this.failed.size > 64) this.failed.delete(this.failed.keys().next().value!);
    await this.store.update((s) => {
      s[layer] = null;
    });
    this.status.message = '当前曲目无法播放，已跳过；曲库全部无效时保持静音。';
  }
  /** Returns true while fade-out is still running. */
  private async fade(obs: MusicDevice, layer: MusicLayer, valid: () => boolean) {
    const fade = this.fades[layer];
    if (!fade || !valid()) return false;
    const progress = fade.ms ? Math.min(1, Math.max(0, (this.now() - fade.at) / fade.ms)) : 1;
    const saved = this.store.state[layer];
    const target = saved ? this.effectiveVolume(saved.group, saved.track) : 0;
    const volume = target * (fade.from + (fade.to - fade.from) * progress);
    await obs.setVolume({ sourceId: fade.sourceId, gain: volume });
    this.appliedVolumes.set(layer, volume);
    if (progress === 1 && valid()) {
      if (fade.stop) {
        this.expectedStops.set(layer, fade.sourceId);
        await obs.controlMedia({
          sourceId: fade.sourceId,
          action: 'stop',
        });
      }
      delete this.fades[layer];
    }
    return fade.stop && progress < 1;
  }
  async close() {
    const previewOwned = this.preview.busy;
    this.preview.cancel('shutdown');
    this.commandRevision++;
    this.resumeLayers.clear();
    this.closed = true;
    this.invalidate();
    this.operationFailures.clear();
    const deadline = Date.now() + 4000;
    let closing = true;
    const current = () => closing && Date.now() < deadline;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let localWriteFailure: unknown;
    const cleanup = async () => {
      while (this.inFlight && current()) await new Promise((resolve) => setTimeout(resolve, 10));
      if (!current()) throw new Error('music_close_timeout');
      if (!Object.values(this.store.state.sources).some(Boolean)) return;
      await this.provider.session(async (rpc, epoch) => {
        const guard = () => {
          if (!current()) throw new Error('music_close_timeout');
        };
        const obs = rpc.guardWrites(guard).checkCalls(guard, true);
        // The audition owner checks external edits, confirms STOP, then restores its lease.
        // Clearing or yielding a persisted lease cannot grant formal media control.
        do {
          await this.reconcilePreview(obs, epoch, current);
          if (this.preview.busy) await new Promise((resolve) => setTimeout(resolve, 50));
        } while (this.preview.busy && current());
        guard();
        if (this.isExternalHold()) return;
        // Closing is also a control boundary: the last poll may predate an OBS edit.
        try {
          if (await this.observeManualControls(obs, current, previewOwned)) return;
        } catch (error) {
          // The observer sets the in-memory hold before persisting it.
          if (this.isExternalHold()) localWriteFailure = error;
          throw error;
        }
        for (const layer of ['bgm', 'stinger'] as const) {
          const playback = this.store.state[layer];
          if (
            !playback ||
            playback.finished ||
            (layer === 'stinger' && (previewOwned || this.isStingerHeld()))
          )
            continue;
          const name = await obs.hasSource(this.store, layer, current);
          if (!name) continue;
          const sourceId = this.store.state.sources[layer]!;
          const args = { sourceId };
          const [media, mute, volume, settings, path] = await Promise.all([
            obs.mediaStatus(args),
            obs.mute(args),
            obs.volume(args),
            obs.mediaFile(args),
            this.store.trackPath(playback.track.id),
          ]);
          guard();
          if (
            this.manualControlObserved(layer, media.state, mute, volume) ||
            (path && settings !== path)
          ) {
            try {
              await this.holdForObsControl();
            } catch (error) {
              localWriteFailure = error;
              throw error;
            }
            return;
          }
          if (
            !path ||
            observedPlayback(media.state) === 'unknown' ||
            typeof mute !== 'boolean' ||
            typeof volume !== 'number' ||
            !Number.isFinite(volume)
          )
            throw new Error('music_close_media_unconfirmed');
          await this.stopMedia(obs, layer, sourceId, current);
          try {
            await this.store.update((s) => {
              guard();
              const saved = s[layer];
              if (saved)
                s[layer] = {
                  ...saved,
                  suspended: true,
                  finished: saved.finished || layer === 'stinger',
                  cursorMs: saved.suspended
                    ? saved.cursorMs
                    : Math.max(0, Number(media.cursorMs) || 0),
                };
            });
          } catch (error) {
            localWriteFailure = error;
            throw error;
          }
          if (layer === 'stinger') await this.preview.recoverMonitor(obs, current);
        }
      });
    };
    try {
      await Promise.race([
        cleanup(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('music_close_timeout')), 4000);
        }),
      ]);
      this.store.previewEvent('music_close', {
        result: this.preview.busy || this.preview.recoveryPending ? 'unconfirmed' : 'success',
      });
    } catch (error) {
      this.store.previewEvent('music_close', { result: 'unconfirmed', error });
    } finally {
      closing = false;
      if (timer) clearTimeout(timer);
      await this.provider.close();
    }
    if (localWriteFailure)
      throw new Error('music_local_close_unconfirmed', { cause: localWriteFailure });
  }
}
