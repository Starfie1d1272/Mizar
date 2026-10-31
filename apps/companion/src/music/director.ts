import { randomUUID } from 'node:crypto';
import type {
  MusicGroup,
  MusicStatus,
  MusicTrack,
  MusicPreviewRequest,
} from '@mizar/protocol/music';
import { musicOpeningScope, type MusicOpeningScope } from '../scope/identities.js';
import type { ObsRpc } from '../obs/reconcile.js';
import type { AudioMonitorChange } from '../obs/audio-migration.js';
import type { MonitorOriginals } from '../obs/audio-routing.js';
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
import { ownedMusicInput, type MusicLayer } from './obs-provider.js';

type MonitorRelationship = 'independent' | 'same' | 'different' | 'unknown';
type MonitorType = AudioMonitorChange['before'];
function desiredMonitorType(relationship: MonitorRelationship, wanted: boolean): MonitorType {
  if (!wanted || relationship === 'unknown') return 'OBS_MONITORING_TYPE_NONE';
  return relationship === 'same'
    ? 'OBS_MONITORING_TYPE_MONITOR_ONLY'
    : 'OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT';
}
function ownedMonitorApplied(original: MonitorOriginals['bgm']): MonitorType | undefined {
  if (!original) return undefined;
  // v1.9.1 stored the pre-mix mode before changing it to monitor-only.
  return (
    original.applied ??
    (original.mode === 'OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT'
      ? 'OBS_MONITORING_TYPE_MONITOR_ONLY'
      : undefined)
  );
}
function monitorRestoreTarget(
  original: MonitorOriginals['bgm'],
  preference: boolean | null,
): MonitorType | undefined {
  if (!original) return undefined;
  return !original.applied && preference === false ? 'OBS_MONITORING_TYPE_NONE' : original.mode;
}
function isMonitorType(value: unknown): value is MonitorType {
  return (
    value === 'OBS_MONITORING_TYPE_NONE' ||
    value === 'OBS_MONITORING_TYPE_MONITOR_ONLY' ||
    value === 'OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT'
  );
}
function observedPlayback(state: unknown): MusicStatus['playback'] {
  if (state === 'OBS_MEDIA_STATE_PLAYING') return 'playing';
  if (state === 'OBS_MEDIA_STATE_PAUSED') return 'paused';
  if (state === 'OBS_MEDIA_STATE_STOPPED' || state === 'OBS_MEDIA_STATE_ENDED') return 'stopped';
  return 'unknown';
}

function mediaMillis(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
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

interface Provider {
  session<T>(run: (rpc: ObsRpc, epoch: number) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
interface Fade {
  name: string;
  inputUuid: string;
  from: number;
  to: number;
  at: number;
  ms: number;
  stop: boolean;
}
export class MusicDirector {
  private readonly preview: MusicPreview;
  private generation = 0;
  private commandRevision = 0;
  private desiredKey = '';
  private inFlight = false;
  private closed = false;
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
  private config = '';
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
    private readonly provider: Provider,
    private readonly truth: () => MusicTruth,
    private readonly now = Date.now,
    private readonly random = Math.random,
    private readonly monitorSafe: (obs: ObsRpc) => Promise<boolean> = () => Promise.resolve(false),
    private readonly monitorRelationship: (obs: ObsRpc) => Promise<MonitorRelationship> = () =>
      Promise.resolve('independent'),
    private readonly audioModePending: () => Promise<boolean> = () => Promise.resolve(false),
  ) {
    this.preview = new MusicPreview(store, now);
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
      held: this.isHeld(),
      intent: this.isHeld() ? 'held' : this.manual ? 'manual' : 'automatic',
      ...(this.preview.status ? { preview: this.preview.status } : {}),
    };
  }
  async setMixer(volume?: number, muted?: boolean): Promise<boolean> {
    if (this.closed || !this.store.ready || this.store.failure)
      throw new Error('music_unavailable');
    await this.store.update((state) => {
      if (volume !== undefined) state.master = volume;
      if (muted !== undefined) state.muted = muted;
    });
    this.invalidate();
    if (this.isHeld()) return false;
    const deadline = Date.now() + 4000;
    while (this.inFlight && !this.closed && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 10));
    if (this.closed || this.inFlight) return false;
    await this.tick();
    return !this.isHeld() && this.status.connection !== 'unavailable';
  }
  async previewRequest(request: MusicPreviewRequest) {
    if (this.closed) throw new Error('music_preview_closed');
    if (request.action === 'start' && this.isExternalHold())
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
      if (this.manual.paused) {
        const stopRevision = this.commandRevision + 1;
        await this.command('stop');
        if (this.closed || this.commandRevision !== stopRevision) return;
      }
      await this.manualPlay(group, track.id, track.entryId);
      return;
    }
    this.preview.cancel('operator_command');
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
    await this.tick();
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
    const revision = ++this.commandRevision;
    this.unknownControl = false;
    this.invalidate();
    this.preview.cancel('formal_cue');
    this.pendingOpening = null;
    this.fades = {};
    this.heldOverride = true;
    await this.store.hold(false);
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
        const name = await ownedMusicInput(obs, this.store, 'bgm', false, current, false);
        const uuid = this.store.state.sources.bgm;
        if (!name || !uuid || !current()) throw new Error('music_source_missing');
        const settings = await obs.call('GetInputSettings', { inputUuid: uuid });
        const path = await this.store.trackPath(manual.cue.track!.id);
        if (!current() || (settings.inputSettings as Record<string, unknown>)?.local_file !== path)
          throw new Error('music_source_changed');
        const before = await obs.call('GetMediaInputStatus', { inputUuid: uuid });
        const mute = await obs.call('GetInputMute', { inputUuid: uuid });
        const volume = await obs.call('GetInputVolume', { inputUuid: uuid });
        if (
          current() &&
          this.manualControlObserved(
            'bgm',
            before.mediaState,
            mute.inputMuted,
            volume.inputVolumeMul,
          )
        ) {
          await this.holdForObsControl();
          throw new Error('music_source_changed');
        }
        if (
          !current() ||
          before.mediaState !== (paused ? 'OBS_MEDIA_STATE_PLAYING' : 'OBS_MEDIA_STATE_PAUSED')
        )
          throw new Error('music_state_changed');
        const actionAt = this.now();
        manual.paused = paused;
        await obs.call('TriggerMediaInputAction', {
          inputUuid: uuid,
          mediaAction: paused
            ? 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PAUSE'
            : 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PLAY',
        });
        if (!current()) return;
        let after = await obs.call('GetMediaInputStatus', { inputUuid: uuid });
        // OBS may acknowledge the command before its media thread reports the
        // new state. Only wait while the previous state is still observable;
        // never resend the command or overwrite another observed state.
        for (let attempt = 0; attempt < 10 && after.mediaState === before.mediaState; attempt++) {
          if (!current()) return;
          await new Promise((resolve) => setTimeout(resolve, 50));
          if (!current()) return;
          after = await obs.call('GetMediaInputStatus', { inputUuid: uuid });
        }
        if (!current()) return;
        this.status.playback = observedPlayback(after.mediaState);
        if (after.mediaState !== (paused ? 'OBS_MEDIA_STATE_PAUSED' : 'OBS_MEDIA_STATE_PLAYING'))
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
            const name = await ownedMusicInput(obs, this.store, 'bgm', false, current, false);
            if (name && current()) {
              const read = await obs.call('GetMediaInputStatus', {
                inputUuid: this.store.state.sources.bgm,
              });
              if (current()) this.status.playback = observedPlayback(read.mediaState);
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
        const name = await ownedMusicInput(obs, this.store, 'bgm', false, current, false);
        const uuid = this.store.state.sources.bgm;
        if (!name || !uuid || !current()) throw new Error('music_source_missing');
        const settings = await obs.call('GetInputSettings', { inputUuid: uuid });
        const path = await this.store.trackPath(saved.track.id);
        if (!current()) throw new Error('music_cancelled');
        if ((settings.inputSettings as Record<string, unknown>)?.local_file !== path) {
          this.unknownControl = true;
          await this.holdForObsControl();
          throw new Error('music_source_changed');
        }
        const media = await obs.call('GetMediaInputStatus', { inputUuid: uuid });
        const mute = await obs.call('GetInputMute', { inputUuid: uuid });
        const volume = await obs.call('GetInputVolume', { inputUuid: uuid });
        if (
          current() &&
          this.manualControlObserved(
            'bgm',
            media.mediaState,
            mute.inputMuted,
            volume.inputVolumeMul,
          )
        ) {
          await this.holdForObsControl();
          throw new Error('music_source_changed');
        }
        const duration = mediaMillis(media.mediaDuration);
        const end = Math.min(saved.track.endMs ?? Infinity, duration ?? Infinity);
        if (
          !current() ||
          !['OBS_MEDIA_STATE_PLAYING', 'OBS_MEDIA_STATE_PAUSED'].includes(String(media.mediaState))
        )
          throw new Error('music_seek_unavailable');
        if (duration === null || duration <= 0 || cursorMs < saved.track.startMs || cursorMs >= end)
          throw new Error('music_seek_invalid');
        writing = true;
        await obs.call('SetMediaInputCursor', { inputUuid: uuid, mediaCursor: cursorMs });
        if (!current()) return;
        const observed = await obs.call('GetMediaInputStatus', { inputUuid: uuid });
        if (!current()) return;
        this.status.cursorMs = mediaMillis(observed.mediaCursor);
        this.status.durationMs = mediaMillis(observed.mediaDuration);
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
        await obs.call('SetInputVolume', { inputUuid: uuid, inputVolumeMul: target });
        if (current()) this.appliedVolumes.set('bgm', target);
      });
    } catch (error) {
      if (writing && current()) {
        await this.provider
          .session(async (obs) => {
            const name = await ownedMusicInput(obs, this.store, 'bgm', false, current, false);
            if (name && current()) {
              const read = await obs.call('GetMediaInputStatus', {
                inputUuid: this.store.state.sources.bgm,
              });
              if (current()) this.status.cursorMs = mediaMillis(read.mediaCursor);
              const volume = await obs.call('GetInputVolume', {
                inputUuid: this.store.state.sources.bgm,
              });
              if (
                current() &&
                typeof volume.inputVolumeMul === 'number' &&
                Number.isFinite(volume.inputVolumeMul)
              )
                this.appliedVolumes.set('bgm', volume.inputVolumeMul);
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

  private async readMonitor(obs: ObsRpc, valid: () => boolean, readOnly = false) {
    const modes: unknown[] = [];
    for (const layer of ['bgm', 'stinger'] as const) {
      const name = await ownedMusicInput(
        obs,
        this.store,
        layer,
        false,
        valid,
        false,
        false,
        !readOnly,
      );
      if (!valid()) return;
      if (!name) continue;
      const read = await obs.call('GetInputAudioMonitorType', {
        inputUuid: this.store.state.sources[layer],
      });
      if (!valid()) return;
      modes.push(read.monitorType);
    }
    this.status.monitor = !modes.length
      ? 'unknown'
      : modes.every((m) =>
            ['OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT', 'OBS_MONITORING_TYPE_MONITOR_ONLY'].includes(
              String(m),
            ),
          )
        ? 'enabled'
        : modes.every((m) => m === 'OBS_MONITORING_TYPE_NONE')
          ? 'disabled'
          : modes.every((m) =>
                [
                  'OBS_MONITORING_TYPE_NONE',
                  'OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT',
                  'OBS_MONITORING_TYPE_MONITOR_ONLY',
                ].includes(String(m)),
              )
            ? 'mixed'
            : 'unknown';
  }

  noteMonitorSettingsChanged() {
    this.monitorSettingsChanged = true;
  }

  private async configureDefaultMonitor(obs: ObsRpc, valid: () => boolean, recheck = false) {
    const wanted = this.store.state.monitorPreference;
    const pending = (['bgm', 'stinger'] as const).filter((layer) => {
      const uuid = this.store.state.sources[layer];
      return uuid && this.store.state.monitorConfigured[layer] !== uuid;
    });
    if (!pending.length && !recheck) return;
    const relationship = await this.monitorRelationship(obs).catch(() => 'unknown' as const);
    if (!valid()) return;
    this.status.monitorPending = wanted === true && relationship === 'unknown';
    if (wanted === null) return;
    const safe = await this.monitorSafe(obs).catch(() => false);
    if (!valid()) return;
    if (!safe) {
      this.status.monitorPending = wanted;
      return;
    }
    for (const layer of ['bgm', 'stinger'] as const) {
      const uuid = this.store.state.sources[layer];
      const original = this.store.state.desktopMonitorOriginal[layer];
      const isNew = pending.includes(layer);
      if (!uuid || (!isNew && (!recheck || !original))) continue;
      const name = await ownedMusicInput(obs, this.store, layer, false, valid, false);
      if (!name || !valid()) return;
      const observed = (await obs.call('GetInputAudioMonitorType', { inputUuid: uuid }))
        .monitorType;
      if (!isMonitorType(observed) || !valid()) return;
      if (
        !(await this.monitorSafe(obs).catch(() => false)) ||
        (await this.monitorRelationship(obs).catch(() => 'unknown' as const)) !== relationship
      ) {
        if (valid()) this.status.monitorPending = wanted;
        return;
      }
      const desired = desiredMonitorType(relationship, wanted);
      if (
        isNew && !original
          ? observed !== 'OBS_MONITORING_TYPE_NONE' && observed !== desired
          : !original || original.uuid !== uuid || ownedMonitorApplied(original) !== observed
      ) {
        // An external edit owns this field; leave it unchanged.
        this.status.monitorPending = wanted;
        continue;
      }
      await this.store.update((state) => {
        state.monitorConfigured[layer] = uuid;
        if (relationship !== 'independent')
          state.desktopMonitorOriginal[layer] = {
            uuid,
            mode:
              monitorRestoreTarget(original, wanted) ??
              (wanted ? 'OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT' : 'OBS_MONITORING_TYPE_NONE'),
            applied: desired,
          };
      });
      if (!valid()) return;
      if (observed !== desired) {
        await obs.call('SetInputAudioMonitorType', { inputUuid: uuid, monitorType: desired });
        if (
          (await obs.call('GetInputAudioMonitorType', { inputUuid: uuid })).monitorType !== desired
        )
          throw new Error('music_monitor_unconfirmed');
      }
    }
  }

  /** Hold music changes while the audio mode journal owns monitor writes. */
  async prepareDesktopMix<T>(
    obs: ObsRpc,
    relationship: MonitorRelationship,
    apply: (plan: {
      changes: AudioMonitorChange[];
      managedMusicUuids: string[];
      musicBefore: MonitorOriginals;
      musicAfter: MonitorOriginals;
    }) => Promise<T>,
  ): Promise<T> {
    return this.withAudioModeRecovery(async (current) => {
      const changes: AudioMonitorChange[] = [];
      const managedMusicUuids: string[] = [];
      const musicBefore = structuredClone(this.store.state.desktopMonitorOriginal);
      const originals: Partial<
        Record<MusicLayer, NonNullable<MonitorOriginals[MusicLayer]> | null>
      > = {};
      for (const layer of ['bgm', 'stinger'] as const) {
        const name = await ownedMusicInput(
          obs,
          this.store,
          layer,
          false,
          current,
          false,
          false,
          false,
        );
        const uuid = this.store.state.sources[layer];
        const original = this.store.state.desktopMonitorOriginal[layer];
        if (!name || !uuid) {
          if (original) throw new Error('music_monitor_source_changed');
          continue;
        }
        const mode = (await obs.call('GetInputAudioMonitorType', { inputUuid: uuid })).monitorType;
        if (!isMonitorType(mode)) throw new Error('music_monitor_unknown');
        managedMusicUuids.push(uuid);
        if (original && original.uuid !== uuid) throw new Error('music_monitor_source_changed');
        const held = ownedMonitorApplied(original);
        if (original && (held === undefined || held !== mode)) {
          // A later external edit owns this field; do not replay the backup.
          originals[layer] = null;
          continue;
        }
        if (relationship === 'independent') {
          const target = monitorRestoreTarget(original, this.store.state.monitorPreference);
          if (target && mode !== target)
            changes.push({
              kind: 'monitor',
              inputUuid: uuid,
              before: mode,
              applied: target,
            });
          if (original) originals[layer] = null;
          continue;
        }
        const wanted = this.store.state.monitorPreference === true;
        const desired = desiredMonitorType(relationship, wanted);
        if (mode !== desired)
          changes.push({ kind: 'monitor', inputUuid: uuid, before: mode, applied: desired });
        originals[layer] = {
          uuid,
          mode: monitorRestoreTarget(original, this.store.state.monitorPreference) ?? mode,
          applied: desired,
        };
      }
      if (!current()) throw new Error('music_cancelled');
      const musicAfter = structuredClone(musicBefore);
      for (const layer of ['bgm', 'stinger'] as const)
        if (originals[layer] !== undefined) musicAfter[layer] = originals[layer]!;
      const result = await apply({ changes, managedMusicUuids, musicBefore, musicAfter });
      this.status.monitorPending =
        relationship === 'unknown' && this.store.state.monitorPreference === true;
      return result;
    });
  }
  monitorPlanCompatible(relationship: MonitorRelationship, after: MonitorOriginals): boolean {
    const desired = desiredMonitorType(relationship, this.store.state.monitorPreference === true);
    return (['bgm', 'stinger'] as const).every(
      (layer) => !after[layer]?.applied || after[layer]!.applied === desired,
    );
  }
  async withAudioModeRecovery<T>(run: (current: () => boolean) => Promise<T>): Promise<T> {
    if (this.closed || !this.store.ready || this.store.failure)
      throw new Error('music_unavailable');
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
    before: MonitorOriginals,
    after: MonitorOriginals,
    side: 'before' | 'after',
  ) {
    if (this.closed || !this.store.ready || this.store.failure)
      throw new Error('music_unavailable');
    await this.store.update((state) => {
      for (const layer of ['bgm', 'stinger'] as const) {
        const current = state.desktopMonitorOriginal[layer];
        const equal = (a: typeof current, b: typeof current) =>
          JSON.stringify(a) === JSON.stringify(b);
        if (!equal(current, before[layer]) && !equal(current, after[layer]))
          throw new Error(`music_monitor_conflict:${layer}`);
        for (const value of [before[layer], after[layer]])
          if (value && state.sources[layer] !== value.uuid)
            throw new Error(`music_monitor_source_changed:${layer}`);
      }
      state.desktopMonitorOriginal = structuredClone(side === 'before' ? before : after);
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
    this.status.monitor = 'unknown';
    try {
      await this.store.update((state) => {
        if (current()) state.monitorPreference = enabled;
      });
      if (!current()) return;
      await this.provider.session(async (obs) => {
        const relation = await this.monitorRelationship(obs).catch(() => 'unknown' as const);
        const monitorPending = enabled && relation === 'unknown';
        for (const layer of ['bgm', 'stinger'] as const) {
          const name = await ownedMusicInput(obs, this.store, layer, true, current, true, true);
          const uuid = this.store.state.sources[layer];
          if (!name || !uuid || !current()) throw new Error('music_cancelled');
          const monitorType = desiredMonitorType(relation, enabled);
          await this.store.update((state) => {
            state.monitorConfigured[layer] = uuid;
            state.desktopMonitorOriginal[layer] =
              relation === 'independent'
                ? null
                : {
                    uuid,
                    mode: enabled
                      ? 'OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT'
                      : 'OBS_MONITORING_TYPE_NONE',
                    applied: monitorType,
                  };
          });
          if (!current()) return;
          await obs.call('SetInputAudioMonitorType', {
            inputUuid: uuid,
            monitorType,
          });
          if (!current()) return;
          const read = await obs.call('GetInputAudioMonitorType', { inputUuid: uuid });
          if (!current()) return;
          if (read.monitorType !== monitorType) throw new Error('music_monitor_unconfirmed');
        }
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
  async tick(): Promise<void> {
    if (this.closed || (await this.audioModePending().catch(() => true))) return;
    if (this.store.failure && this.preview.busy) this.preview.cancel('storage_unavailable');
    if (this.store.failure && !this.preview.busy) {
      this.status.connection = 'unavailable';
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
      if (this.store.failure || !this.store.ready) {
        await this.provider.session(async (obs, epoch) => {
          await this.preview.reconcile(
            obs,
            epoch,
            valid,
            false,
            (uuid) => this.expectedStops.set('stinger', uuid),
            () => this.holdForObsControl(),
          );
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
      const signature = JSON.stringify([
        this.store.state.config,
        this.store.state.master,
        this.store.state.muted,
      ]);
      const configChanged = Boolean(this.config && this.config !== signature);
      this.config = signature;
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
        this.status.message = null;
        if (this.isExternalHold()) {
          await this.observeHeldPlayback(obs, valid);
          if (valid()) await this.readMonitor(obs, valid, true);
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
        await this.preview.reconcile(
          obs,
          epoch,
          valid,
          previewSafe,
          (uuid) => this.expectedStops.set('stinger', uuid),
          () => this.holdForObsControl(),
        );
        const monitorRecheck = reconnect || this.monitorSettingsChanged;
        this.monitorSettingsChanged = false;
        await this.configureDefaultMonitor(obs, valid, monitorRecheck);
        if (valid() && this.preview.busy) await this.readMonitor(obs, valid);
        if (!valid() || this.preview.busy) return;
        if (this.unknownControl) {
          const name = await ownedMusicInput(obs, this.store, 'bgm', false, valid, false);
          if (name && valid()) {
            const media = await obs.call('GetMediaInputStatus', {
              inputUuid: this.store.state.sources.bgm,
            });
            this.status.playback = observedPlayback(media.mediaState);
          }
          this.status.message = '音乐控制未确认，请在 OBS 核对后停止音乐或恢复自动。';
          return;
        }
        // Observe both existing layers before changing a cue or attributing a stop to the system.
        if (await this.observeManualControls(obs, valid, previewOwned)) return;
        await this.layer(obs, 'bgm', cue, valid, configChanged, reconnect);
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
            configChanged,
            reconnect,
          );
        } else if (!previewOwned) {
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
            configChanged,
            reconnect,
          );
        }
        await this.configureDefaultMonitor(obs, valid);
        if (valid()) await this.readMonitor(obs, valid);
      });
    } catch (error) {
      if (!(error instanceof Error && error.message === 'music_cancelled'))
        this.preview.unavailable();
      if (valid()) {
        this.status.connection = 'unavailable';
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
          error instanceof Error && error.message === 'music_cancelled'
            ? null
            : '音乐控制未确认。请在 OBS 检查或停止 音乐来源；连接恢复后会重新核对。';
      }
    } finally {
      this.inFlight = false;
    }
  }
  private manualControlObserved(
    layer: MusicLayer,
    state: unknown,
    muted: unknown,
    volume: unknown,
  ) {
    if (this.isHeld() || this.resumeLayers.has(layer)) return false;
    const saved = this.store.state[layer];
    const active = [
      'OBS_MEDIA_STATE_PLAYING',
      'OBS_MEDIA_STATE_OPENING',
      'OBS_MEDIA_STATE_BUFFERING',
    ].includes(String(state));
    const expectedVolume =
      this.appliedVolumes.get(layer) ??
      (saved ? this.effectiveVolume(saved.group, saved.track) : null);
    return (
      muted === true ||
      Boolean(layer === 'bgm' && this.manual?.paused && state === 'OBS_MEDIA_STATE_PLAYING') ||
      (state === 'OBS_MEDIA_STATE_PAUSED' && !(layer === 'bgm' && this.manual?.paused)) ||
      Boolean(
        saved &&
        !saved.finished &&
        !saved.suspended &&
        ((state === 'OBS_MEDIA_STATE_STOPPED' &&
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
  private async observeHeldPlayback(obs: ObsRpc, valid: () => boolean) {
    this.status.stinger = null;
    const name = await ownedMusicInput(obs, this.store, 'bgm', false, valid, false, false, false);
    if (!valid()) return;
    if (!name) {
      this.status.playback = 'unknown';
      this.status.bgm = null;
      this.status.cursorMs = null;
      this.status.durationMs = null;
      this.status.segmentStartMs = null;
      this.status.segmentEndMs = null;
    } else {
      const args = { inputUuid: this.store.state.sources.bgm };
      const [media, volume, mute, settings] = await Promise.all([
        obs.call('GetMediaInputStatus', args),
        obs.call('GetInputVolume', args),
        obs.call('GetInputMute', args),
        obs.call('GetInputSettings', args),
      ]);
      if (!valid()) return;
      this.status.playback = observedPlayback(media.mediaState);
      this.status.cursorMs = mediaMillis(media.mediaCursor);
      this.status.durationMs = mediaMillis(media.mediaDuration);
      const saved = this.store.state.bgm;
      const path = saved ? await this.store.trackPath(saved.track.id).catch(() => null) : null;
      if (!valid()) return;
      const matches =
        path && (settings.inputSettings as Record<string, unknown>)?.local_file === path;
      this.status.bgm =
        saved && matches && !saved.finished
          ? {
              group: saved.group,
              track: saved.track.name,
              playbackId: saved.key,
              volume:
                mute.inputMuted === true
                  ? 0
                  : typeof volume.inputVolumeMul === 'number' &&
                      Number.isFinite(volume.inputVolumeMul)
                    ? Math.min(1, Math.max(0, volume.inputVolumeMul))
                    : this.effectiveVolume(saved.group, saved.track),
            }
          : null;
      this.status.segmentStartMs = this.status.bgm ? saved!.track.startMs : null;
      this.status.segmentEndMs = this.status.bgm ? saved!.track.endMs : null;
    }
    const stinger = this.store.state.stinger;
    if (stinger && !stinger.finished) {
      const stingerName = await ownedMusicInput(
        obs,
        this.store,
        'stinger',
        false,
        valid,
        false,
        false,
        false,
      );
      if (stingerName && valid()) {
        const stingerArgs = { inputUuid: this.store.state.sources.stinger };
        const [stingerMedia, stingerSettings, stingerPath] = await Promise.all([
          obs.call('GetMediaInputStatus', stingerArgs),
          obs.call('GetInputSettings', stingerArgs),
          this.store.trackPath(stinger.track.id).catch(() => null),
        ]);
        if (!valid()) return;
        if (
          stingerPath &&
          (stingerSettings.inputSettings as Record<string, unknown>)?.local_file === stingerPath &&
          ['playing', 'paused'].includes(observedPlayback(stingerMedia.mediaState))
        )
          this.status.stinger = stinger.track.name;
      }
    }
  }
  private async observeManualControls(obs: ObsRpc, valid: () => boolean, skipStinger = false) {
    if (this.isHeld()) return false;
    for (const layer of ['bgm', 'stinger'] as const) {
      if (skipStinger && layer === 'stinger') continue;
      if (!this.store.state.sources[layer] || this.resumeLayers.has(layer)) continue;
      const name = await ownedMusicInput(obs, this.store, layer, false, valid);
      if (!name) continue;
      const args = { inputUuid: this.store.state.sources[layer] };
      const call = (type: string) => {
        if (!valid()) throw new Error('music_cancelled');
        return obs.call(type, args);
      };
      const [media, mute, volume] = await Promise.all([
        call('GetMediaInputStatus'),
        call('GetInputMute'),
        call('GetInputVolume'),
      ]);
      if (!valid()) throw new Error('music_cancelled');
      if (layer === 'bgm') this.status.playback = observedPlayback(media.mediaState);
      if (
        this.manualControlObserved(layer, media.mediaState, mute.inputMuted, volume.inputVolumeMul)
      ) {
        await this.holdForObsControl();
        return true;
      }
    }
    return false;
  }
  private async waitAfterRestart(
    obs: ObsRpc,
    layer: MusicLayer,
    inputUuid: string,
    cursorMs: number,
    valid: () => boolean,
  ) {
    const deadline = Date.now() + 2000;
    while (valid()) {
      const media = await obs.call('GetMediaInputStatus', { inputUuid });
      const mute = await obs.call('GetInputMute', { inputUuid });
      if (!valid()) throw new Error('music_cancelled');
      if (mute.inputMuted === true || media.mediaState === 'OBS_MEDIA_STATE_PAUSED') {
        await this.holdForObsControl();
        return false;
      }
      if (media.mediaState === 'OBS_MEDIA_STATE_PLAYING') {
        const volume = await obs.call('GetInputVolume', { inputUuid });
        if (!valid()) throw new Error('music_cancelled');
        if (this.manualControlObserved(layer, media.mediaState, false, volume.inputVolumeMul)) {
          await this.holdForObsControl();
          return false;
        }
        if (cursorMs) await obs.call('SetMediaInputCursor', { inputUuid, mediaCursor: cursorMs });
        return true;
      }
      if (Date.now() >= deadline) throw new Error('music_media_start_timeout');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('music_cancelled');
  }
  private async layer(
    obs: ObsRpc,
    layer: MusicLayer,
    cue: MusicCue | null,
    valid: () => boolean,
    configChanged: boolean,
    reconnect: boolean,
  ) {
    const call = async (type: string, data: Record<string, unknown>) => {
      if (!valid()) throw new Error('music_cancelled');
      if (type === 'TriggerMediaInputAction') {
        if (data.mediaAction === 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_STOP')
          this.expectedStops.set(layer, String(data.inputUuid));
        else if (data.mediaAction === 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART')
          this.expectedStops.delete(layer);
      }
      return obs.call(type, data);
    };
    let saved = this.store.state[layer];
    const spec = cue ? this.store.state.config.groups[cue.group] : null;
    const enabled = Boolean(
      cue && (this.manual?.cue === cue || spec?.enabled) && (cue.track || spec?.tracks.length),
    );
    const previousUuid = this.store.state.sources[layer];
    const name = await ownedMusicInput(obs, this.store, layer, enabled, valid, reconnect);
    if (cue && previousUuid !== this.store.state.sources[layer]) this.failed.delete(cue.key);
    if (!name) return;
    saved = this.store.state[layer];
    const args = { inputUuid: this.store.state.sources[layer]! };
    const media = await call('GetMediaInputStatus', args);
    const mute = await call('GetInputMute', args);
    const volume = await call('GetInputVolume', args);
    const settings = await call('GetInputSettings', args);
    const resuming = this.resumeLayers.has(layer);
    if (resuming) {
      await call('SetInputMute', { ...args, inputMuted: false });
      this.resumeLayers.delete(layer);
      mute.inputMuted = false;
    }
    const state = media.mediaState;
    if (layer === 'bgm') {
      this.status.playback = observedPlayback(state);
      this.status.cursorMs = mediaMillis(media.mediaCursor);
      this.status.durationMs = mediaMillis(media.mediaDuration);
      this.status.segmentStartMs = saved?.track.startMs ?? null;
      this.status.segmentEndMs = saved?.track.endMs ?? null;
    }
    const active =
      state === 'OBS_MEDIA_STATE_PLAYING' ||
      state === 'OBS_MEDIA_STATE_OPENING' ||
      state === 'OBS_MEDIA_STATE_BUFFERING';
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
    if (
      !resuming &&
      this.manualControlObserved(layer, state, mute.inputMuted, volume.inputVolumeMul)
    ) {
      await this.holdForObsControl();
      markStatus(null);
      return;
    }
    if (!enabled) {
      // Gameplay/stale/manual stop bypass ordinary fades. No delayed work can delay a cut.
      delete this.fades[layer];
      if (active || state === 'OBS_MEDIA_STATE_PAUSED')
        await call('TriggerMediaInputAction', {
          ...args,
          mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_STOP',
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
            cursorMs: Math.max(0, Number(media.mediaCursor) || 0),
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
        await call('TriggerMediaInputAction', {
          ...args,
          mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_STOP',
        });
      markStatus(null);
      return;
    }
    if (matching && saved) {
      const targetVolume = this.effectiveVolume(saved.group, saved.track);
      const file = (settings.inputSettings as Record<string, unknown>)?.local_file;
      const expectedPath = await this.store.trackPath(saved.track.id).catch(() => null);
      if (!expectedPath || file !== expectedPath) {
        if (active)
          await call('TriggerMediaInputAction', {
            ...args,
            mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_STOP',
          });
        await this.fail(layer, saved);
        return;
      }
      if (layer === 'bgm' && this.manual?.paused && state === 'OBS_MEDIA_STATE_PAUSED') {
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
          tailVolume(
            saved.track,
            mediaMillis(media.mediaCursor),
            mediaMillis(media.mediaDuration),
            targetVolume,
            spec!.fadeOutMs,
          ),
        );
        if (Math.abs(target - Number(volume.inputVolumeMul)) > 0.0001) {
          await call('SetInputVolume', { ...args, inputVolumeMul: target });
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
          await call('SetInputVolume', { ...args, inputVolumeMul: targetVolume });
          this.appliedVolumes.set(layer, targetVolume);
        }
        if (!active) {
          await call('SetInputVolume', {
            ...args,
            inputVolumeMul: spec!.fadeInMs ? 0 : targetVolume,
          });
          this.appliedVolumes.set(layer, spec!.fadeInMs ? 0 : targetVolume);
          await call('TriggerMediaInputAction', {
            ...args,
            mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART',
          });
          if (!(await this.waitAfterRestart(obs, layer, args.inputUuid, saved.cursorMs, valid)))
            return;
          this.fades[layer] = {
            name,
            inputUuid: args.inputUuid,
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
        saved.track.endMs !== null && Number(media.mediaCursor) >= saved.track.endMs;
      if (state === 'OBS_MEDIA_STATE_ERROR' || state === 'OBS_MEDIA_STATE_NONE') {
        await this.fail(layer, saved);
        return;
      }
      if (
        state === 'OBS_MEDIA_STATE_ENDED' ||
        segmentEnded ||
        (layer === 'bgm' && this.nextRequested)
      ) {
        this.nextRequested = false;
        if (segmentEnded || active)
          await call('TriggerMediaInputAction', {
            ...args,
            mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_STOP',
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
          tailVolume(
            saved.track,
            mediaMillis(media.mediaCursor),
            mediaMillis(media.mediaDuration),
            targetVolume,
            spec!.fadeOutMs,
          ),
        );
        if (valid() && Math.abs(gain - Number(volume.inputVolumeMul)) > 0.0001)
          await call('SetInputVolume', { ...args, inputVolumeMul: gain });
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
          name,
          inputUuid: args.inputUuid,
          from:
            this.effectiveVolume(saved.group, saved.track) > 0
              ? Number(volume.inputVolumeMul) / this.effectiveVolume(saved.group, saved.track)
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
    await call('TriggerMediaInputAction', {
      ...args,
      mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_STOP',
    });
    await call('SetInputVolume', { ...args, inputVolumeMul: spec!.fadeInMs ? 0 : targetVolume });
    this.appliedVolumes.set(layer, spec!.fadeInMs ? 0 : targetVolume);
    await call('SetInputSettings', {
      ...args,
      overlay: true,
      inputSettings: {
        is_local_file: true,
        local_file: path,
        looping: false,
        restart_on_activate: false,
        close_when_inactive: false,
      },
    });
    // An identical file does not reliably autostart after STOP in OBS.
    await call('TriggerMediaInputAction', {
      ...args,
      mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART',
    });
    if (!(await this.waitAfterRestart(obs, layer, args.inputUuid, track.startMs, valid))) return;
    await this.store.update((s) => {
      if (s[layer]?.key === saved.key && s[layer]?.track.id === saved.track.id)
        s[layer] = { ...saved, suspended: false };
    });
    this.fades[layer] = {
      name,
      inputUuid: args.inputUuid,
      from: spec!.fadeInMs ? 0 : 1,
      to: 1,
      at: this.now(),
      ms: spec!.fadeInMs,
      stop: false,
    };
    markStatus(saved);
    if (layer === 'bgm' && valid()) {
      const observed = await call('GetMediaInputStatus', args);
      this.status.playback = observedPlayback(observed.mediaState);
      this.status.cursorMs = mediaMillis(observed.mediaCursor);
      this.status.durationMs = mediaMillis(observed.mediaDuration);
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
  private async fade(obs: ObsRpc, layer: MusicLayer, valid: () => boolean) {
    const fade = this.fades[layer];
    if (!fade || !valid()) return false;
    const progress = fade.ms ? Math.min(1, Math.max(0, (this.now() - fade.at) / fade.ms)) : 1;
    const saved = this.store.state[layer];
    const target = saved ? this.effectiveVolume(saved.group, saved.track) : 0;
    const volume = target * (fade.from + (fade.to - fade.from) * progress);
    await obs.call('SetInputVolume', { inputUuid: fade.inputUuid, inputVolumeMul: volume });
    this.appliedVolumes.set(layer, volume);
    if (progress === 1 && valid()) {
      if (fade.stop) {
        this.expectedStops.set(layer, fade.inputUuid);
        await obs.call('TriggerMediaInputAction', {
          inputUuid: fade.inputUuid,
          mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_STOP',
        });
      }
      delete this.fades[layer];
    }
    return fade.stop && progress < 1;
  }
  async close() {
    this.preview.cancel('shutdown');
    this.commandRevision++;
    this.closed = true;
    this.invalidate();
    // Wait only for the bounded active RPC, then stop owned sources without changing manual hold.
    while (this.inFlight) await new Promise((resolve) => setTimeout(resolve, 10));
    if (!this.isExternalHold() && Object.values(this.store.state.sources).some(Boolean))
      await this.provider
        .session(async (obs) => {
          for (const layer of ['bgm', 'stinger'] as const) {
            const name = await ownedMusicInput(obs, this.store, layer, false, () => true);
            if (name) {
              const media = await obs.call('GetMediaInputStatus', {
                inputUuid: this.store.state.sources[layer]!,
              });
              await obs.call('TriggerMediaInputAction', {
                inputUuid: this.store.state.sources[layer]!,
                mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_STOP',
              });
              await this.store.update((s) => {
                const saved = s[layer];
                if (saved)
                  s[layer] = {
                    ...saved,
                    suspended: true,
                    finished: saved.finished || layer === 'stinger',
                    cursorMs: saved.suspended
                      ? saved.cursorMs
                      : Math.max(0, Number(media.mediaCursor) || 0),
                  };
              });
            }
          }
        })
        .catch(() => undefined);
    await this.provider.close();
  }
}
