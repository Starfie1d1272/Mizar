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
  MusicAudioMode,
  MusicDevice,
  MusicDeviceProvider,
  MusicLayer,
  MusicMediaState,
  MusicMonitorMode,
  MusicMixerControl,
} from './device.js';
import {
  desiredMusicMonitorMode,
  musicCue,
  musicMapKey,
  musicPause,
  musicSafe,
  observedPlayback,
  resolveEffectiveBgmCue,
  resolveRetainedStingerCue,
  tailVolume,
  type MusicCue,
  type MusicTruth,
} from './cues.js';
import { looping, type MusicStore, type Playback } from './store.js';
import { MusicPreview } from './preview.js';

interface Fade {
  sourceId: string;
  from: number;
  to: number;
  at: number;
  ms: number;
  stop: boolean;
}
type LayerMediaSnapshot = {
  media: Awaited<ReturnType<MusicDevice['mediaStatus']>>;
  mute: boolean | undefined;
  volume: number | undefined;
};
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
  private pendingHold: 'external' | 'stop' | null = null;
  private pendingOpening: {
    key: string;
    expires: number;
    scope: MusicOpeningScope;
    track?: MusicTrack;
  } | null = null;
  private fades: Partial<Record<MusicLayer, Fade>> = {};
  private expectedStops = new Map<MusicLayer, string>();
  private appliedVolumes = new Map<MusicLayer, number>();
  private externalDriftCounts = new Map<MusicLayer, { count: number; tick: number }>();
  private driftTick = 0;
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
  private monitorSynced = new Map<MusicLayer, string>();
  private monitorSettingsChanged = false;
  private nextMonitorDisableAttempt = 0;
  private lastPoll = -Infinity;
  private probeBackoff = { at: 0, delayMs: 0, collectionRevision: undefined as number | undefined };
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
    private readonly waitForObsConnection: () => boolean = () => false,
  ) {
    this.preview = new MusicPreview(store, now);
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
    return this.pendingHold !== null || this.store.state.held;
  }
  private isExternalHold() {
    return (
      this.isHeld() &&
      (this.pendingHold ?? this.store.state.holdReason ?? 'external') === 'external'
    );
  }
  private isStingerHeld() {
    return (
      Boolean(this.store.state.stingerHeld) &&
      !(this.isHeld() && (this.pendingHold ?? this.store.state.holdReason) === 'stop')
    );
  }
  private resetPlaybackIntent() {
    this.pendingOpening = null;
    this.fades = {};
    this.nextRequested = false;
    this.resumeLayers.clear();
    this.invalidate();
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
      ...(this.store.state.monitorDisablePending ? { monitorDisablePending: true } : {}),
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
  private async waitIdle(valid: () => boolean, timeoutMs?: number): Promise<void> {
    const deadline = timeoutMs === undefined ? Infinity : Date.now() + timeoutMs;
    while (this.inFlight && valid() && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 10));
    if (!valid()) throw new Error('music_cancelled');
    if (this.inFlight) throw new Error('music_control_pending');
  }
  private async acquireCommand<T>(
    valid: () => boolean,
    run: () => Promise<T>,
    timeoutMs?: number,
  ): Promise<T> {
    await this.waitIdle(valid, timeoutMs);
    this.inFlight = true;
    try {
      return await run();
    } finally {
      this.inFlight = false;
    }
  }
  private async readVerifiedBgmLayer(
    obs: MusicDevice,
    trackId: string,
    current: () => boolean,
    holdOnPathMismatch = false,
  ) {
    const name = await obs.hasSource(this.store, 'bgm', current);
    const uuid = this.store.state.sources.bgm;
    if (!name || !uuid || !current()) throw new Error('music_source_missing');
    const [layerRead, path] = await Promise.all([
      this.readLayerMedia(obs, uuid),
      this.store.trackPath(trackId),
    ]);
    if (!current()) throw new Error('music_cancelled');
    if (layerRead.settings !== path) {
      if (holdOnPathMismatch) {
        this.unknownControl = true;
        await this.holdForObsControl();
      }
      throw new Error('music_source_changed');
    }
    if (
      current() &&
      this.manualControlObserved(
        'bgm',
        layerRead.media.state,
        layerRead.mute,
        layerRead.volume,
        true,
      )
    ) {
      await this.holdForObsControl('bgm');
      throw new Error('music_source_changed');
    }
    return { uuid, ...layerRead };
  }
  private async readLayerMedia(obs: MusicDevice, sourceId: string) {
    const args = { sourceId };
    const [media, mute, volume, settings] = await Promise.all([
      obs.mediaStatus(args),
      obs.mute(args),
      obs.volume(args),
      obs.mediaFile(args),
    ]);
    return { args, media, mute, volume, settings };
  }
  private async markUnknownObsControl(): Promise<void> {
    this.manual = null;
    this.unknownControl = true;
    this.pendingHold = 'external';
    await this.store.hold(true).catch(() => undefined);
  }
  private async refreshBgmPlaybackStatus(
    obs: MusicDevice,
    current: () => boolean,
    withDetails = false,
  ) {
    if ((await obs.hasSource(this.store, 'bgm', current)) && current()) {
      const sourceId = this.store.state.sources.bgm!;
      const read = await obs.mediaStatus({ sourceId });
      if (!current()) return;
      if (withDetails) {
        this.status.cursorMs = read.cursorMs;
        const volume = await obs.volume({ sourceId });
        if (current() && typeof volume === 'number' && Number.isFinite(volume))
          this.appliedVolumes.set('bgm', volume);
      } else {
        this.status.playback = observedPlayback(read.state);
      }
    }
  }
  private async startLayerPlayback(
    obs: MusicDevice,
    layer: MusicLayer,
    sourceId: string,
    fadeInMs: number,
    targetVolume: number,
    startMs: number,
    valid: () => boolean,
  ): Promise<boolean> {
    const initial = fadeInMs ? 0 : targetVolume;
    await obs.setVolume({ sourceId, gain: initial });
    this.appliedVolumes.set(layer, initial);
    await obs.controlMedia({ sourceId, action: 'restart' });
    if (layer === 'stinger') this.expectedStops.delete(layer);
    if (!(await this.waitAfterRestart(obs, layer, sourceId, startMs, valid))) return false;
    this.fades[layer] = {
      sourceId,
      from: fadeInMs ? 0 : 1,
      to: 1,
      at: this.now(),
      ms: fadeInMs,
      stop: false,
    };
    return true;
  }
  private resolveAutomaticCue(truth: MusicTruth, map: string): MusicCue | null {
    if (!this.store.automaticEnabled || this.isHeld()) return null;
    return (
      this.manual?.cue ??
      resolveEffectiveBgmCue(
        truth,
        map,
        this.store.state.pause?.id ?? null,
        this.store.state.bgm,
        this.store.state.consumed,
      )
    );
  }
  private computedLayerGain(
    layer: MusicLayer,
    saved: Playback,
    media: { cursorMs: number | null; durationMs: number | null },
    targetVolume: number,
    fadeOutMs: number,
    at: number,
    clearOnComplete = false,
  ): number {
    const fade = this.fades[layer];
    let gain = targetVolume;
    if (fade && !fade.stop) {
      const progress = fade.ms ? Math.min(1, Math.max(0, (at - fade.at) / fade.ms)) : 1;
      gain = targetVolume * (fade.from + (fade.to - fade.from) * progress);
      if (clearOnComplete && progress === 1) delete this.fades[layer];
    } else if (clearOnComplete && fade?.stop) {
      delete this.fades[layer];
    }
    return Math.min(
      gain,
      tailVolume(saved.track, media.cursorMs, media.durationMs, targetVolume, fadeOutMs),
    );
  }
  private setBgmStatus(
    media: { state: MusicMediaState; cursorMs: number | null; durationMs: number | null },
    track?: MusicTrack | null,
  ): void {
    this.status.playback = observedPlayback(media.state);
    this.status.cursorMs = media.cursorMs;
    this.status.durationMs = media.durationMs;
    this.status.segmentStartMs = track?.startMs ?? null;
    this.status.segmentEndMs = track?.endMs ?? null;
  }
  private async applyLayerMonitor(
    obs: MusicDevice,
    layer: MusicLayer,
    uuid: string,
    desired: MusicMonitorMode,
    valid: () => boolean,
  ): Promise<void> {
    await obs.setMonitorMode({ sourceId: uuid, mode: desired });
    if (!valid()) return;
    if ((await obs.monitorMode({ sourceId: uuid })) !== desired)
      throw new Error('music_monitor_unconfirmed');
    this.monitorSynced.set(layer, uuid);
  }
  /** Explicit controls only touch media/mixer fields, never route or monitor fields. */
  private async immediateControl(
    current: () => boolean,
    run: (obs: MusicDevice, layer: MusicLayer, uuid: string) => Promise<void>,
  ): Promise<void> {
    return this.acquireCommand(
      current,
      async () => {
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
        }
      },
      4000,
    );
  }
  private async stopMedia(obs: MusicDevice, layer: MusicLayer, uuid: string, valid: () => boolean) {
    if (!valid()) throw new Error('music_cancelled');
    this.expectedStops.set(layer, uuid);
    await obs.controlMedia({
      sourceId: uuid,
      action: 'stop',
    });
    if (!valid()) throw new Error('music_cancelled');
    const stopped = (state: MusicMediaState) => ['stopped', 'ended', 'empty'].includes(state);
    let read = await obs.mediaStatus({ sourceId: uuid });
    for (let attempt = 0; attempt < 10 && !stopped(read.state); attempt++) {
      if (!valid()) throw new Error('music_cancelled');
      await new Promise((resolve) => setTimeout(resolve, 50));
      if (!valid()) throw new Error('music_cancelled');
      read = await obs.mediaStatus({ sourceId: uuid });
    }
    if (!valid()) throw new Error('music_cancelled');
    if (!stopped(read.state)) throw new Error('music_stop_unconfirmed');
    if (layer === 'stinger' && this.preview.confirmStopped(uuid))
      await this.preview.syncMonitor(obs, valid);
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
    if (this.pendingOpening && this.pendingOpening.expires < this.now()) this.pendingOpening = null;
    if (request.action === 'start') {
      if (
        this.pendingOpening ||
        (this.store.state.stinger &&
          !this.store.state.stinger.finished &&
          !this.store.state.stinger.suspended)
      )
        throw new Error('music_preview_opening_busy');
      if (this.isExternalHold() || this.isStingerHeld())
        throw new Error('music_preview_channel_busy');
    }
    this.preview.submit(request);
    while (this.inFlight && !this.closed) await new Promise((resolve) => setTimeout(resolve, 10));
    this.lastPoll = -Infinity;
    await this.tick(true);
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
    // Cancel playback work; command validity is independent of telemetry changes.
    this.resetPlaybackIntent();
    let persistenceError: unknown;
    if (action !== 'next') {
      // Resume stays quiet until both persistence steps confirm this is still the newest command.
      this.pendingHold = action === 'stop' ? 'stop' : 'external';
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
          this.pendingHold = null;
        }
      } catch (error) {
        if (!current()) return;
        this.pendingHold = 'external';
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
    } else await this.tick(true);
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
    this.resetPlaybackIntent();
    this.preview.cancel('formal_cue');
    this.pendingHold = 'external';
    await this.store.hold(false, 'external', preserveStinger);
    if (revision !== this.commandRevision || this.closed) return;
    this.pendingHold = null;
    this.resumeLayers = new Set(this.store.state.sources.bgm ? ['bgm'] : []);
    this.manual = {
      cue: { group, key: `manual:${randomUUID()}`, track },
      paused: false,
      pausedAt: null,
      epoch: null,
    };
    try {
      await this.waitIdle(() => revision === this.commandRevision && !this.closed);
    } catch {
      return;
    }
    this.lastPoll = -Infinity;
    await this.tick(true);
    if (this.status.connection !== 'connected' || !this.manual)
      throw new Error('music_play_unconfirmed');
  }
  private async runBgmCommand(
    current: () => boolean,
    withDetails: boolean,
    initialWriting: boolean,
    fn: (obs: MusicDevice, epoch: number, markWriting: () => void) => Promise<void>,
  ) {
    this.invalidate();
    return this.acquireCommand(current, async () => {
      let writing = initialWriting;
      try {
        await this.provider.session((obs, epoch) => fn(obs, epoch, () => (writing = true)));
      } catch (error) {
        if (writing && current()) {
          await this.provider
            .session((obs) => this.refreshBgmPlaybackStatus(obs, current, withDetails))
            .catch(() => {
              if (withDetails && current()) this.status.cursorMs = null;
            });
          if (current()) {
            this.status.playback = 'unknown';
            await this.markUnknownObsControl();
          }
        }
        throw error;
      }
    });
  }
  async manualPause(paused: boolean) {
    const manual = this.manual;
    if (!manual || this.closed) throw new Error('music_manual_inactive');
    const revision = ++this.commandRevision;
    const current = () =>
      !this.closed && revision === this.commandRevision && this.manual === manual;
    return this.runBgmCommand(current, false, true, async (obs, epoch) => {
      if (!current() || manual.epoch !== epoch) throw new Error('music_cancelled');
      const { uuid, media: before } = await this.readVerifiedBgmLayer(
        obs,
        manual.cue.track!.id,
        current,
      );
      if (!current() || before.state !== (paused ? 'playing' : 'paused'))
        throw new Error('music_state_changed');
      const actionAt = this.now();
      manual.paused = paused;
      await obs.controlMedia({ sourceId: uuid, action: paused ? 'pause' : 'play' });
      if (!current()) return;
      let after = await obs.mediaStatus({ sourceId: uuid });
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
    }).catch((error) => {
      if (error instanceof Error && error.message === 'music_cancelled') return;
      throw error;
    });
  }
  async seek(cursorMs: number, playbackId: string) {
    if (!Number.isInteger(cursorMs) || cursorMs < 0 || this.closed)
      throw new Error('music_seek_invalid');
    const saved = this.store.state.bgm;
    if (!saved || saved.key !== playbackId || saved.finished || saved.suspended || this.isHeld())
      throw new Error('music_seek_unavailable');
    const revision = ++this.commandRevision;
    const current = () =>
      !this.closed && revision === this.commandRevision && this.store.state.bgm?.key === saved.key;
    return this.runBgmCommand(current, true, false, async (obs, epoch, markWriting) => {
      if (epoch !== this.epoch || !current()) throw new Error('music_cancelled');
      const { uuid, media } = await this.readVerifiedBgmLayer(obs, saved.track.id, current, true);
      const duration = media.durationMs;
      const end = Math.min(saved.track.endMs ?? Infinity, duration ?? Infinity);
      if (!current() || !['playing', 'paused'].includes(media.state))
        throw new Error('music_seek_unavailable');
      if (duration === null || duration <= 0 || cursorMs < saved.track.startMs || cursorMs >= end)
        throw new Error('music_seek_invalid');
      markWriting();
      await obs.setMediaCursor({ sourceId: uuid, cursorMs });
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
  }

  private async readMonitor(
    obs: MusicDevice,
    valid: () => boolean,
    known?: Map<MusicLayer, MusicMonitorMode | undefined>,
  ) {
    const modes: (MusicMonitorMode | undefined)[] = [];
    for (const layer of ['bgm', 'stinger'] as const) {
      if (known?.has(layer)) {
        modes.push(known.get(layer));
        continue;
      }
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

  private async configureDefaultMonitor(
    obs: MusicDevice,
    valid: () => boolean,
    recheck = false,
  ): Promise<Map<MusicLayer, MusicMonitorMode | undefined>> {
    const known = new Map<MusicLayer, MusicMonitorMode | undefined>();
    if (!valid()) return known;
    const desired = desiredMusicMonitorMode(this.store.state.monitorPreference === true);
    for (const layer of ['bgm', 'stinger'] as const) {
      if (layer === 'stinger' && this.preview.busy) continue;
      const uuid = this.store.state.sources[layer];
      if (!uuid) continue;
      if (!recheck && this.monitorSynced.get(layer) === uuid) continue;
      const name = await obs.hasSource(this.store, layer, valid);
      if (!name || !valid()) return known;
      const observed = await obs.monitorMode({ sourceId: uuid });
      if (observed === undefined || !valid()) return known;
      known.set(layer, observed);
      if (observed !== desired) {
        await this.applyLayerMonitor(obs, layer, uuid, desired, valid);
        known.set(layer, desired);
      } else {
        this.monitorSynced.set(layer, uuid);
      }
    }
    return known;
  }

  mixerStatus(): ReturnType<MusicMixerControl['mixerStatus']> {
    const status = this.get();
    const { state, ready } = this.store;
    return {
      desktopIncludesMusic: false,
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
  async withAudioModeRecovery<T>(run: (current: () => boolean) => Promise<T>): Promise<T> {
    if (this.closed) throw new Error('music_unavailable');
    const revision = ++this.commandRevision;
    this.invalidate();
    const current = () => !this.closed && revision === this.commandRevision;
    return this.acquireCommand(current, () => run(current));
  }
  async monitor(enabled: boolean) {
    if (this.closed || !this.store.ready || this.store.failure)
      throw new Error('music_unavailable');
    const revision = ++this.commandRevision;
    this.invalidate();
    const current = () => !this.closed && revision === this.commandRevision;
    return this.acquireCommand(current, async () => {
      try {
        if (!current()) return;
        await this.store.update((state) => {
          if (!current()) return;
          state.monitorPreference = enabled;
          delete state.monitorDisablePending;
        });
        if (!current()) return;
        this.preview.cancel('monitor_control');
        this.status.monitor = 'unknown';
        await this.provider.session(async (obs) => {
          await this.reconcilePreview(obs, this.epoch, current);
          let found = false;
          const desired = desiredMusicMonitorMode(enabled);
          for (const layer of ['bgm', 'stinger'] as const) {
            const name = await obs.hasSource(this.store, layer, current);
            const uuid = this.store.state.sources[layer];
            if (!current()) throw new Error('music_cancelled');
            if (!name || !uuid) continue;
            found = true;
            await this.applyLayerMonitor(obs, layer, uuid, desired, current);
          }
          if (!found) throw new Error('music_source_missing');
          if (current()) this.status.monitor = enabled ? 'enabled' : 'disabled';
        });
      } catch (error) {
        if (current()) {
          this.status.monitor = 'unknown';
          await this.provider
            .session((obs) => this.readMonitor(obs, current))
            .catch(() => undefined);
        }
        throw error;
      }
    }).catch((error) => {
      if (error instanceof Error && error.message === 'music_cancelled') return;
      throw error;
    });
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
      scope: musicOpeningScope(t.program),
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
    if (previewOwned && !this.preview.busy) {
      this.expectedStops.delete('stinger');
      this.monitorSynced.delete('stinger');
    }
  }
  async tick(explicit = false): Promise<void> {
    if (this.closed) return;
    const modePending = await this.audioModePending().catch(() => true);
    const waitingForObs = () => !explicit && !this.manual && this.waitForObsConnection();
    if (
      !modePending &&
      !this.closed &&
      !this.inFlight &&
      this.store.ready &&
      !this.store.failure &&
      this.store.state.monitorDisablePending &&
      this.now() >= this.nextMonitorDisableAttempt
    ) {
      if (waitingForObs()) return;
      this.nextMonitorDisableAttempt = this.now() + 5_000;
      await this.monitor(false).catch(() => undefined);
      return;
    }
    // Route recovery defers automatic playback, never an already-started audition's stop.
    const automaticDeferred =
      modePending && !this.manual && !(this.isHeld() && !this.isExternalHold());
    if (this.closed) return;
    if (automaticDeferred && !this.preview.busy) return;
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
      musicOpeningScope(truth.program),
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
    const { bgm, stinger } = this.store.state;
    if (
      !explicit &&
      !truth.production &&
      !this.manual &&
      !this.unknownControl &&
      (!bgm || bgm.finished) &&
      (!stinger || stinger.finished) &&
      !this.preview.busy
    ) {
      this.status.connection = 'idle';
      return;
    }
    const collectionRevision = this.provider.collectionRevision;
    if (collectionRevision !== this.probeBackoff.collectionRevision)
      this.probeBackoff = { at: 0, delayMs: 0, collectionRevision };
    const now = this.now();
    if (this.pendingOpening && this.pendingOpening.expires < now) this.pendingOpening = null;
    if (!explicit && now < (this.provider.nextConnectionAttemptAt ?? 0)) return;
    const probeCooling = !explicit && now < this.probeBackoff.at;
    if (probeCooling) {
      // Finish owned preview work without resuming automatic playback probes.
      if (!this.preview.busy) return;
      if (now - this.lastPoll < 2000) return;
    }
    // Facts still invalidate every 100 ms; steady media polling is bounded, fades remain smooth.
    const interval = Object.keys(this.fades).length || this.preview.busy ? 100 : 250;
    if (!changed && !this.pendingOpening && this.now() - this.lastPoll < interval) return;
    this.lastPoll = this.now();
    this.inFlight = true;
    const generation = this.generation;
    const currentCollection = () => collectionRevision === this.provider.collectionRevision;
    const valid = () => !this.closed && generation === this.generation && currentCollection();
    const recovered = () => {
      this.probeBackoff.at = 0;
      this.probeBackoff.delayMs = 0;
      this.operationFailures.clear('music_operation_recovered');
    };
    const waitForAutomaticAudio = () => {
      if (this.preview.busy || !waitingForObs()) return false;
      this.status.connection = this.status.connection === 'idle' ? 'idle' : 'unavailable';
      if (this.status.connection === 'unavailable') this.status.playback = 'unknown';
      return true;
    };
    try {
      if (probeCooling || automaticDeferred || this.store.failure || !this.store.ready) {
        if (waitForAutomaticAudio()) return;
        const cleanupCurrent = () => !this.closed && currentCollection();
        await this.provider.session(async (obs, epoch) => {
          await this.reconcilePreview(obs, epoch, cleanupCurrent);
          if (valid()) {
            this.status.connection = 'connected';
            this.status.failure = null;
            this.status.message = null;
          }
        });
        if (valid() && !probeCooling) recovered();
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
      const cue = this.resolveAutomaticCue(truth, map);
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
      if (waitForAutomaticAudio()) return;
      this.driftTick++;
      await this.provider.session(async (obs, epoch) => {
        const reconnect = this.epoch !== epoch;
        if (reconnect) {
          this.externalDriftCounts.clear();
          this.monitorSynced.clear();
        }
        if (!valid()) return;
        if (this.manual) this.manual.epoch = epoch;
        this.epoch = epoch;
        this.status.connection = 'connected';
        this.status.failure = null;
        this.status.message = null;
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
        const currentTruth = this.truth();
        const p = currentTruth.program;
        const previewSafe =
          !this.pendingOpening &&
          !opening &&
          (p.map.phase !== 'live' ||
            Boolean(musicCue(currentTruth, this.store.state.pause?.id ?? null))) &&
          (p.map.phase === null || (musicSafe(p) && p.status.telemetry === 'fresh'));
        await this.reconcilePreview(obs, epoch, valid, previewSafe);
        const monitorRecheck = reconnect || this.monitorSettingsChanged;
        this.monitorSettingsChanged = false;
        if (!valid()) return;
        const syncMonitor = async () => {
          const known = await this.configureDefaultMonitor(obs, valid, monitorRecheck);
          if (valid()) await this.readMonitor(obs, valid, known);
        };
        if (this.preview.busy) {
          await syncMonitor();
          return;
        }
        if (this.unknownControl) {
          await this.refreshBgmPlaybackStatus(obs, valid);
          this.status.message = '音乐控制未确认，请在 OBS 核对后停止音乐或恢复自动。';
          return;
        }
        // Observe both existing layers before changing a cue or attributing a stop to the system.
        const observed = await this.observeManualControls(obs, valid, previewOwned);
        if (!observed) return;
        await this.layer(obs, 'bgm', cue, valid, observed.get('bgm'));
        let stingerCue: MusicCue | null | undefined;
        if (
          opening &&
          opening.scope === musicOpeningScope(p) &&
          opening.expires >= this.now() &&
          valid() &&
          !this.isHeld()
        ) {
          await this.store.consume(opening.key); // At-most-once across uncertain RPCs / process restarts.
          stingerCue = {
            group: 'opening',
            key: opening.key,
            scope: opening.scope,
            ...(opening.track ? { track: opening.track } : {}),
          };
        } else if (!previewOwned && !this.isStingerHeld()) {
          stingerCue = resolveRetainedStingerCue(
            truth,
            Boolean(this.manual),
            this.isHeld(),
            this.store.state.stinger,
          );
        }
        if (stingerCue !== undefined)
          await this.layer(obs, 'stinger', stingerCue, valid, observed.get('stinger'));
        await syncMonitor();
      });
      if (valid()) recovered();
    } catch (error) {
      if (
        this.closed ||
        !currentCollection() ||
        (error instanceof Error && error.message === 'music_cancelled')
      )
        return;
      const failure = musicFailure(error);
      if (
        !probeCooling &&
        (failure.code === 'scene_missing' ||
          (error instanceof Error &&
            ['music_obs_timeout', 'music_obs_request_failed'].includes(error.message)))
      ) {
        this.probeBackoff.delayMs = Math.min(10000, Math.max(2000, this.probeBackoff.delayMs * 2));
        this.probeBackoff.at = this.now() + this.probeBackoff.delayMs;
      }
      try {
        const diagnostic = diagnosticValue(error);
        this.operationFailures.record(
          'music_operation_failed',
          JSON.stringify([this.epoch, collectionRevision, failure.code]),
          { error: diagnostic, code: failure.code },
        );
      } catch {
        this.store.previewEvent('music_operation_failed', { error, code: failure.code });
      }
      if (valid()) {
        this.preview.unavailable(error);
        this.status.failure = failure.code;
        this.status.connection = failure.code === 'obs_disconnected' ? 'unavailable' : 'connected';

        if (!valid()) return;
        this.status.playback = 'unknown';
        this.status.cursorMs = null;
        this.status.durationMs = null;
        this.status.monitor = 'unknown';
        this.status.message = failure.message;
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
    immediate = false,
  ) {
    if ((layer === 'bgm' ? this.isHeld() : this.isStingerHeld()) || this.resumeLayers.has(layer)) {
      this.externalDriftCounts.delete(layer);
      return false;
    }
    const saved = this.store.state[layer];
    if ((saved?.finished || saved?.suspended) && ['stopped', 'ended', 'empty'].includes(state))
      this.expectedStops.delete(layer);
    const playing = state === 'playing';
    const expectedVolume =
      this.appliedVolumes.get(layer) ??
      (saved ? this.effectiveVolume(saved.group, saved.track) : null);
    const definiteExternal =
      // A registered source or a monitor receipt is not an active formal playback grant.
      (playing &&
        (!saved || saved.finished) &&
        this.expectedStops.get(layer) !== this.store.state.sources[layer]) ||
      (muted === true && !this.store.state.muted) ||
      Boolean(layer === 'bgm' && this.manual?.paused && playing) ||
      (state === 'paused' && !(layer === 'bgm' && this.manual?.paused));
    if (definiteExternal) {
      this.externalDriftCounts.delete(layer);
      return true;
    }
    const transientMismatch = Boolean(
      saved &&
      !saved.finished &&
      !saved.suspended &&
      !this.fades[layer] &&
      ((state === 'stopped' &&
        this.appliedVolumes.has(layer) &&
        this.expectedStops.get(layer) !== this.store.state.sources[layer]) ||
        (playing &&
          typeof volume === 'number' &&
          Number.isFinite(volume) &&
          expectedVolume !== null &&
          Math.abs(volume - expectedVolume) > 0.03)),
    );
    if (!transientMismatch) {
      this.externalDriftCounts.delete(layer);
      return false;
    }
    if (immediate) return true;
    const previous = this.externalDriftCounts.get(layer);
    if (previous && previous.tick === this.driftTick) return previous.count >= 2;
    const count = (previous?.count ?? 0) + 1;
    this.externalDriftCounts.set(layer, { count, tick: this.driftTick });
    return count >= 2;
  }
  private async holdForObsControl(layer?: MusicLayer) {
    this.externalDriftCounts.clear();
    if (layer === 'stinger') {
      await this.store.update((state) => {
        state.stingerHeld = true;
      });
      return;
    }
    this.commandRevision++;
    this.manual = null;
    this.preview.cancel('manual_control');
    this.pendingHold = 'external';
    this.resetPlaybackIntent();
    await this.store.hold(true, 'external', this.isStingerHeld());
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
      this.status.bgm = null;
      this.setBgmStatus({ state: 'unknown', cursorMs: null, durationMs: null }, null);
    } else {
      const { media, volume, mute, settings } = await this.readLayerMedia(
        obs,
        this.store.state.sources.bgm!,
      );
      if (!valid()) return;
      const saved = this.store.state.bgm;
      this.setBgmStatus(media, saved?.track);
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
  private async observeManualControls(
    obs: MusicDevice,
    valid: () => boolean,
    skipStinger = false,
  ): Promise<Map<MusicLayer, LayerMediaSnapshot> | null> {
    const observed = new Map<MusicLayer, LayerMediaSnapshot>();
    if (this.isHeld()) return observed;
    for (const layer of ['bgm', 'stinger'] as const) {
      if ((skipStinger || this.isStingerHeld()) && layer === 'stinger') continue;
      if (!this.store.state.sources[layer] || this.resumeLayers.has(layer)) continue;
      const name = await obs.hasSource(this.store, layer, valid);
      if (!name) continue;
      const args = { sourceId: this.store.state.sources[layer]! };
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
        await this.holdForObsControl(layer);
        if (layer === 'bgm') return null;
      } else {
        observed.set(layer, { media, mute, volume });
      }
    }
    return observed;
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
        await this.holdForObsControl(layer);
        return false;
      }
      if (media.state === 'playing') {
        const volume = await obs.volume({ sourceId });
        if (!valid()) throw new Error('music_cancelled');
        if (this.manualControlObserved(layer, media.state, false, volume, true)) {
          await this.holdForObsControl(layer);
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
    preRead?: LayerMediaSnapshot,
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
    if (!preRead && !(await obs.hasSource(this.store, layer, valid))) {
      if (enabled) throw new Error('music_source_missing');
      return;
    }
    if (enabled) await obs.verifyPlayback(this.store, layer, valid);
    saved = this.store.state[layer];
    const sourceId = this.store.state.sources[layer]!;
    const args = { sourceId };
    const {
      media,
      mute: initialMute,
      volume,
      settings,
    } = preRead
      ? {
          ...preRead,
          settings: enabled ? await device.mediaFile(args) : undefined,
        }
      : await this.readLayerMedia(device, sourceId);
    let mute = initialMute;
    const resuming = this.resumeLayers.has(layer);
    if (resuming) {
      await device.setMute({ ...args, muted: false });
      this.resumeLayers.delete(layer);
      mute = false;
    }
    const state = media.state;
    if (layer === 'bgm') this.setBgmStatus(media, saved?.track);
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
    if (!preRead && !resuming && this.manualControlObserved(layer, state, mute, volume)) {
      await this.holdForObsControl(layer);
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
          const program = this.truth().program;
          const finished =
            layer === 'stinger' ||
            (program.status.telemetry === 'fresh' &&
              program.map.phase === 'live' &&
              ['mapVictory', 'matchVictory'].includes(saved!.group));
          if (finished)
            s.consumed = [...s.consumed.filter((key) => key !== saved!.key), saved!.key].slice(-64);
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
    const stopAndClear = async () => {
      if (active) await controlMedia({ ...args, action: 'stop' });
      markStatus(null);
    };
    if (matching && saved!.finished) {
      await stopAndClear();
      return;
    }
    if (matching && saved) {
      const targetVolume = this.effectiveVolume(saved.group, saved.track);
      const file = settings;
      const expectedPath = await this.store.trackPath(saved.track.id).catch(() => null);
      if (!expectedPath || file !== expectedPath) {
        await stopAndClear();
        await this.fail(layer, saved);
        return;
      }
      const syncVolume = async (at: number, clearFade: boolean) => {
        const gain = this.computedLayerGain(
          layer,
          saved!,
          media,
          targetVolume,
          spec!.fadeOutMs,
          at,
          clearFade,
        );
        if (
          valid() &&
          (!clearFade || !this.externalDriftCounts.has(layer)) &&
          Math.abs(gain - Number(volume)) > 0.0001
        )
          await device.setVolume({ ...args, gain });
        if (valid()) this.appliedVolumes.set(layer, gain);
        markStatus(saved);
      };
      if (layer === 'bgm' && this.manual?.paused && state === 'paused') {
        await syncVolume(this.manual.pausedAt ?? this.now(), false);
        return;
      }
      if (saved.suspended) {
        await this.store.update((s) => {
          s[layer] = { ...saved!, suspended: false };
        });
        if (active) {
          await device.setVolume({ ...args, gain: targetVolume });
          this.appliedVolumes.set(layer, targetVolume);
        } else if (
          !(await this.startLayerPlayback(
            obs,
            layer,
            args.sourceId,
            spec!.fadeInMs,
            targetVolume,
            saved.cursorMs,
            valid,
          ))
        )
          return;
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
        if (segmentEnded || active) await controlMedia({ ...args, action: 'stop' });
        if (!looping(saved.group)) {
          await this.store.update((s) => {
            s[layer] = { ...saved!, finished: true };
            s.consumed = [...s.consumed.filter((key) => key !== saved!.key), saved!.key].slice(-64);
          });
          delete this.fades[layer];
          markStatus(null);
          return;
        }
      } else if (active) {
        await syncVolume(this.now(), true);
        return; // Reconcile an existing source without Restart or seek.
      } else if (this.appliedVolumes.has(layer) || state !== 'stopped') return;
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
    saved = {
      group: cue!.group,
      key: cue!.key,
      ...(cue!.scope ? { scope: cue!.scope } : {}),
      track,
      configRevision: this.store.state.configRevision,
      finished: false,
      suspended: Boolean(path),
      cursorMs: track.startMs,
    };
    if (!path) {
      await this.fail(layer, saved);
      return;
    }
    // Persist intent before issuing a start; on restart a one-shot is only reconciled, never replayed.
    await this.store.update((s) => {
      s[layer] = saved;
    });
    if (!valid()) return;
    await controlMedia({
      ...args,
      action: 'stop',
    });
    await device.loadMedia({ ...args, path });
    this.expectedStops.delete(layer);
    if (
      !(await this.startLayerPlayback(
        obs,
        layer,
        args.sourceId,
        spec!.fadeInMs,
        targetVolume,
        track.startMs,
        valid,
      ))
    )
      return;
    await this.store.update((s) => {
      if (s[layer]?.key === saved.key && s[layer]?.track.id === saved.track.id)
        s[layer] = { ...saved, suspended: false };
    });
    markStatus(saved);
    if (layer === 'bgm' && valid()) this.setBgmStatus(await device.mediaStatus(args), saved.track);
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
        let observed: Map<MusicLayer, LayerMediaSnapshot> | null;
        try {
          observed = await this.observeManualControls(obs, current, previewOwned);
          if (!observed) return;
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
          const pre = observed.get(layer);
          if (!pre && !(await obs.hasSource(this.store, layer, current))) continue;
          const sourceId = this.store.state.sources[layer]!;
          const [{ media, mute, volume, settings }, path] = await Promise.all([
            pre
              ? obs.mediaFile({ sourceId }).then((settings) => ({ ...pre, settings }))
              : this.readLayerMedia(obs, sourceId),
            this.store.trackPath(playback.track.id),
          ]);
          guard();
          if (
            this.manualControlObserved(layer, media.state, mute, volume, true) ||
            (path && settings !== path)
          ) {
            try {
              await this.holdForObsControl(layer);
            } catch (error) {
              localWriteFailure = error;
              throw error;
            }
            if (layer === 'bgm') return;
            continue;
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
          if (layer === 'stinger') await this.preview.syncMonitor(obs, current);
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
        result: this.preview.busy ? 'unconfirmed' : 'success',
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
