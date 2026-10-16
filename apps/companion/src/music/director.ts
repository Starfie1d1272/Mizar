import { randomUUID } from 'node:crypto';
import type { MusicGroup, MusicStatus } from '@mizar/protocol/music';
import type { ObsRpc } from '../obs/reconcile.js';
import {
  musicCue,
  musicMapKey,
  musicPause,
  musicSafe,
  type MusicCue,
  type MusicTruth,
} from './cues.js';
import { looping, type MusicStore, type Playback } from './store.js';
import { ownedMusicInput, type MusicLayer } from './obs-provider.js';

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
  private generation = 0;
  private desiredKey = '';
  private inFlight = false;
  private closed = false;
  private heldOverride: boolean | null = null;
  private pendingOpening: { key: string; expires: number } | null = null;
  private fades: Partial<Record<MusicLayer, Fade>> = {};
  private appliedVolumes = new Map<MusicLayer, number>();
  private config = '';
  private failed = new Map<string, Set<string>>();
  private status: MusicStatus = {
    held: false,
    connection: 'idle',
    message: null,
    bgm: null,
    stinger: null,
  };
  private epoch = 0;
  private lastPoll = -Infinity;
  private nextRequested = false;
  private resumeLayers = new Set<MusicLayer>();
  constructor(
    readonly store: MusicStore,
    private readonly provider: Provider,
    private readonly truth: () => MusicTruth,
    private readonly now = Date.now,
    private readonly random = Math.random,
  ) {}
  private isHeld() {
    return this.heldOverride ?? this.store.state.held;
  }
  get(): MusicStatus {
    return { ...this.status, held: this.isHeld() };
  }
  invalidate() {
    this.generation++;
    this.desiredKey = '';
  }
  async command(action: 'stop' | 'resume' | 'next') {
    this.invalidate(); // Cancel obsolete starts/fades before waiting for persistence.
    this.fades = {};
    this.pendingOpening = null;
    let persistenceError: unknown;
    if (action !== 'next') {
      this.heldOverride = action === 'stop';
      try {
        await this.store.hold(action === 'stop');
      } catch (error) {
        this.heldOverride = true;
        persistenceError = error;
      }
    } else if (!this.isHeld()) this.nextRequested = true;
    if (action === 'resume') {
      this.resumeLayers = new Set(['bgm', 'stinger']);
      this.failed.clear();
      this.appliedVolumes.clear();
      await this.store.update((s) => {
        if (s.bgm && !s.bgm.finished) s.bgm.suspended = true;
      });
    }
    await this.tick();
    if (persistenceError)
      throw new Error('music_hold_persistence_failed', { cause: persistenceError });
  }
  /** Only called by an actual, current Take start. Never reconstructed from scene snapshots. */
  opening(key: string) {
    const t = this.truth();
    if (
      this.closed ||
      this.isHeld() ||
      !t.production ||
      !musicSafe(t.program) ||
      t.program.status.telemetry !== 'fresh'
    )
      return;
    if (this.store.state.consumed.includes(key)) return;
    this.pendingOpening = { key, expires: this.now() + 1000 };
  }
  private choose(group: MusicGroup, key: string, previous?: string) {
    const spec = this.store.state.config.groups[group];
    const tracks = spec.tracks.filter((t) => !this.failed.get(key)?.has(t.id));
    if (!spec.enabled || !tracks.length) return null;
    if (!looping(group)) return tracks[0]!;
    if (spec.order === 'shuffle') {
      const candidates = tracks.length > 1 ? tracks.filter((t) => t.id !== previous) : tracks;
      const pool = candidates.length ? candidates : tracks;
      return pool[Math.floor(this.random() * pool.length)]!;
    }
    return tracks[(tracks.findIndex((t) => t.id === previous) + 1) % tracks.length]!;
  }
  async tick(): Promise<void> {
    if (this.closed) return;
    if (this.store.failure) {
      this.status.connection = 'unavailable';
      this.status.message = '本机音乐配置无法读取，音乐已停用。请保留原文件并检查本机配置。';
      return;
    }
    if (!this.store.ready) return;
    const truth = this.truth();
    const map = musicMapKey(truth.program);
    const pause =
      musicSafe(truth.program) &&
      truth.program.status.telemetry === 'fresh' &&
      musicPause(truth.program);
    // Invalidate synchronously even while an OBS request is awaiting its reply.
    const preliminary = JSON.stringify([
      truth.production,
      musicSafe(truth.program),
      truth.program.status.telemetry,
      map,
      truth.program.map.phase,
      truth.program.clock?.phase,
      (truth.program.clock?.endsInSeconds ?? 999) <= 5,
      truth.active,
      this.isHeld(),
      this.store.state.config,
    ]);
    const changed = preliminary !== this.desiredKey;
    if (changed) {
      this.desiredKey = preliminary;
      this.generation++;
    }
    if (this.inFlight) return;
    // Facts still invalidate every 100 ms; steady media polling is bounded, fades remain smooth.
    const interval = Object.keys(this.fades).length ? 100 : 250;
    if (!changed && !this.pendingOpening && this.now() - this.lastPoll < interval) return;
    this.lastPoll = this.now();
    this.inFlight = true;
    const generation = this.generation;
    const valid = () => !this.closed && generation === this.generation;
    try {
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
      if (this.isHeld()) cue = null;
      const opening = this.pendingOpening;
      this.pendingOpening = null;
      const hasSources = Object.values(this.store.state.sources).some(Boolean);
      const configured =
        cue &&
        this.store.state.config.groups[cue.group].enabled &&
        this.store.state.config.groups[cue.group].tracks.length;
      if (!hasSources && !configured && !opening) {
        this.status.connection = 'idle';
        return;
      }
      const signature = JSON.stringify(this.store.state.config);
      const configChanged = Boolean(this.config && this.config !== signature);
      this.config = signature;
      await this.provider.session(async (obs, epoch) => {
        const reconnect = this.epoch !== epoch;
        this.epoch = epoch;
        this.status.connection = 'connected';
        this.status.message = null;
        await this.layer(obs, 'bgm', cue, valid, configChanged, reconnect);
        if (opening && opening.expires >= this.now() && valid() && !this.isHeld()) {
          await this.store.consume(opening.key); // At-most-once across uncertain RPCs / process restarts.
          await this.layer(
            obs,
            'stinger',
            { group: 'opening', key: opening.key },
            valid,
            configChanged,
            reconnect,
          );
        } else {
          const stinger = this.store.state.stinger;
          const safe =
            truth.production &&
            musicSafe(truth.program) &&
            truth.program.status.telemetry === 'fresh' &&
            !this.isHeld();
          await this.layer(
            obs,
            'stinger',
            safe && stinger && !stinger.finished ? { group: 'opening', key: stinger.key } : null,
            valid,
            configChanged,
            reconnect,
          );
        }
      });
    } catch (error) {
      if (valid()) {
        this.status.connection = 'unavailable';
        this.status.message =
          error instanceof Error && error.message === 'music_cancelled'
            ? null
            : '音乐控制未确认。请在 OBS 检查或停止 Mizar 音乐来源；连接恢复后会重新核对。';
      }
    } finally {
      this.inFlight = false;
    }
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
      return obs.call(type, data);
    };
    let saved = this.store.state[layer];
    const spec = cue ? this.store.state.config.groups[cue.group] : null;
    const enabled = Boolean(cue && spec?.enabled && spec.tracks.length);
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
    if (this.resumeLayers.has(layer)) {
      await call('SetInputMute', { ...args, inputMuted: false });
      this.resumeLayers.delete(layer);
      mute.inputMuted = false;
    }
    const state = media.mediaState;
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
                volume: this.store.state.config.groups[p.group].volume,
              }
            : null;
      else this.status.stinger = p && !p.finished ? p.track.name : null;
    };
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
          if (finished) s.consumed = [...s.consumed, saved!.key].slice(-64);
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
    if (mute.inputMuted === true && !this.resumeLayers.has(layer)) {
      this.heldOverride = true;
      await this.store.hold(true);
      this.invalidate();
      return;
    }
    const matching =
      saved?.key === cue!.key &&
      saved.group === cue!.group &&
      spec!.tracks.some(
        (t) =>
          t.id === saved!.track.id &&
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
      if (saved.suspended) {
        await this.store.update((s) => {
          s[layer] = { ...saved!, suspended: false };
        });
        if (active) {
          await call('SetInputVolume', { ...args, inputVolumeMul: spec!.volume });
          this.appliedVolumes.set(layer, spec!.volume);
        }
        if (!active) {
          await call('SetInputVolume', {
            ...args,
            inputVolumeMul: spec!.fadeInMs ? 0 : spec!.volume,
          });
          await call('TriggerMediaInputAction', {
            ...args,
            mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART',
          });
          if (saved.cursorMs)
            await call('SetMediaInputCursor', { ...args, mediaCursor: saved.cursorMs });
          this.appliedVolumes.set(layer, spec!.fadeInMs ? 0 : spec!.volume);
          this.fades[layer] = {
            name,
            inputUuid: args.inputUuid,
            from: spec!.fadeInMs ? 0 : spec!.volume,
            to: spec!.volume,
            at: this.now(),
            ms: spec!.fadeInMs,
            stop: false,
          };
        }
        markStatus(saved);
        return;
      }
      // A user's OBS stop, pause, mute or volume change is a persistent manual hold.
      const expectedVolume = this.appliedVolumes.get(layer) ?? spec!.volume;
      if (
        mute.inputMuted === true ||
        state === 'OBS_MEDIA_STATE_STOPPED' ||
        state === 'OBS_MEDIA_STATE_PAUSED' ||
        (active &&
          !configChanged &&
          expectedVolume !== null &&
          Math.abs(Number(volume.inputVolumeMul) - expectedVolume) > 0.015)
      ) {
        this.heldOverride = true;
        await this.store.hold(true);
        this.invalidate();
        this.fades = {};
        markStatus(null);
        return;
      }
      if (configChanged && active) {
        delete this.fades[layer];
        await call('SetInputVolume', { ...args, inputVolumeMul: spec!.volume });
        this.appliedVolumes.set(layer, spec!.volume);
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
            s.consumed = [...s.consumed, saved!.key].slice(-64);
          });
          delete this.fades[layer];
          markStatus(null);
          return;
        }
      } else if (active) {
        const endingAt = saved.track.endMs ?? Number(media.mediaDuration);
        const remainingMs = endingAt - Number(media.mediaCursor);
        if (
          endingAt > 0 &&
          remainingMs > 0 &&
          remainingMs <= spec!.fadeOutMs &&
          this.fades[layer]?.to !== 0
        ) {
          this.fades[layer] = {
            name,
            inputUuid: args.inputUuid,
            from: Number(volume.inputVolumeMul),
            to: 0,
            at: this.now(),
            ms: remainingMs,
            stop: false,
          };
        }
        await this.fade(obs, layer, valid);
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
          from: Number(volume.inputVolumeMul),
          to: 0,
          at: this.now(),
          ms: oldSpec.fadeOutMs,
          stop: true,
        };
      if (await this.fade(obs, layer, valid)) return;
    }
    const track = this.choose(cue!.group, cue!.key, matching ? saved?.track.id : undefined);
    if (!track) {
      this.status.message = '本组曲目均无法播放，保持静音。请检查音频文件或重新选曲。';
      markStatus(null);
      return;
    }
    const path = await this.store.trackPath(track.id).catch(() => null);
    if (!path) {
      saved = {
        group: cue!.group,
        key: cue!.key,
        track,
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
      track,
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
    await call('SetInputVolume', { ...args, inputVolumeMul: spec!.fadeInMs ? 0 : spec!.volume });
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
    if (track.startMs) await call('SetMediaInputCursor', { ...args, mediaCursor: track.startMs });
    await this.store.update((s) => {
      if (s[layer]?.key === saved.key && s[layer]?.track.id === saved.track.id)
        s[layer] = { ...saved, suspended: false };
    });
    this.appliedVolumes.set(layer, spec!.fadeInMs ? 0 : spec!.volume);
    this.fades[layer] = {
      name,
      inputUuid: args.inputUuid,
      from: spec!.fadeInMs ? 0 : spec!.volume,
      to: spec!.volume,
      at: this.now(),
      ms: spec!.fadeInMs,
      stop: false,
    };
    markStatus(saved);
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
    const volume = fade.from + (fade.to - fade.from) * progress;
    await obs.call('SetInputVolume', { inputUuid: fade.inputUuid, inputVolumeMul: volume });
    this.appliedVolumes.set(layer, volume);
    if (progress === 1 && valid()) {
      if (fade.stop)
        await obs.call('TriggerMediaInputAction', {
          inputUuid: fade.inputUuid,
          mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_STOP',
        });
      delete this.fades[layer];
    }
    return fade.stop && progress < 1;
  }
  async close() {
    this.closed = true;
    this.invalidate();
    // Wait only for the bounded active RPC, then stop owned sources without changing manual hold.
    while (this.inFlight) await new Promise((resolve) => setTimeout(resolve, 10));
    if (Object.values(this.store.state.sources).some(Boolean))
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
