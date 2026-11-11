import { musicFailure } from './failure.js';
import type { MusicPreviewRequest, MusicPreviewStatus } from '@mizar/protocol/music';
import type { MusicDevice } from './device.js';
import { PreviewMonitor, type PreviewMonitorTarget } from './preview-monitor.js';
import type { MusicStore } from './store.js';

const active = (state: unknown) =>
  ['OBS_MEDIA_STATE_PLAYING', 'OBS_MEDIA_STATE_OPENING', 'OBS_MEDIA_STATE_BUFFERING'].includes(
    String(state),
  );

/** Borrows only the idle owned stinger. It never writes a formal Playback or consumes a cue. */
export class MusicPreview {
  status: MusicPreviewStatus | undefined;
  private request: MusicPreviewRequest | null = null;
  private operations = new Map<string, { operation: number; until: number }>();
  private revision = 0;
  private lease = 0;
  private deadline = 0;
  private started = 0;
  private fadeAt = 0;
  private uuid: string | null = null;
  private path = '';
  private expectedVolume = 0;
  private expectedMuted = false;
  private pendingVolume: { before: number; applied: number } | null = null;
  private pendingMute: { before: boolean; applied: boolean } | null = null;
  private envelope = 0;
  private epoch = 0;
  private stopping = false;
  private stopSent = false;
  private forceStop = false;
  private failureMessage: string | null = null;
  private readonly monitor: PreviewMonitor;
  constructor(
    private readonly store: MusicStore,
    private readonly now: () => number,
    monitorTarget: PreviewMonitorTarget = () => Promise.resolve(null),
  ) {
    this.monitor = new PreviewMonitor(store, monitorTarget);
  }
  ownsMonitor(uuid: string): boolean {
    return this.uuid === uuid || this.monitor.owns(uuid);
  }
  /** Recover only after the media borrow ends; false freezes this field, not other controls. */
  async recoverMonitor(obs: MusicDevice, valid: () => boolean): Promise<boolean> {
    if (this.uuid) return false;
    const restored = await this.monitor.restore(obs, valid);
    if (!restored && valid() && this.status?.phase === 'stopped')
      this.status = { ...this.status, message: '试听已停止；本机监听恢复未确认，请在 OBS 核对。' };
    return restored;
  }
  get busy() {
    return Boolean(this.request || this.uuid);
  }
  get recoveryPending() {
    return this.store.state.previewMonitorLeases.length > 0;
  }
  /** Share the borrowed source's current gain with the normal mixer owner. */
  mixerVolume(uuid: string): number | null {
    if (this.uuid !== uuid || !this.request) return null;
    return (
      (this.store.state.muted ? 0 : this.store.state.master) *
      (this.request.track.gain ?? this.request.volume) *
      this.envelope
    );
  }
  /** Register before dispatch. A lost reply retains both possible owned values. */
  async prepareMixer(
    obs: MusicDevice,
    uuid: string,
    volume?: number,
    muted?: boolean,
  ): Promise<void> {
    if (this.uuid !== uuid) return;
    if (this.pendingVolume || this.pendingMute) {
      const [gain, mute] = await Promise.all([
        obs.volume({ inputUuid: uuid }),
        obs.mute({ inputUuid: uuid }),
      ]);
      if (!this.observeMixer(gain.inputVolumeMul, mute.inputMuted))
        throw new Error('music_preview_mixer_changed');
    }
    if (volume !== undefined) this.pendingVolume = { before: this.expectedVolume, applied: volume };
    if (muted !== undefined) this.pendingMute = { before: this.expectedMuted, applied: muted };
  }
  confirmMixer(uuid: string, volume?: number, muted?: boolean): void {
    if (this.uuid !== uuid) return;
    if (volume !== undefined) {
      this.expectedVolume = volume;
      this.pendingVolume = null;
    }
    if (muted !== undefined) {
      this.expectedMuted = muted;
      this.pendingMute = null;
    }
  }
  private observeMixer(volume: unknown, muted: unknown): boolean {
    if (typeof volume !== 'number' || !Number.isFinite(volume) || typeof muted !== 'boolean')
      throw new Error('music_preview_mixer_unconfirmed');
    const volumes = this.pendingVolume
      ? [this.pendingVolume.before, this.pendingVolume.applied]
      : [this.expectedVolume];
    const mutes = this.pendingMute
      ? [this.pendingMute.before, this.pendingMute.applied]
      : [this.expectedMuted];
    if (!volumes.some((value) => Math.abs(volume - value) <= 0.015) || !mutes.includes(muted))
      return false;
    this.confirmMixer(this.uuid!, volume, muted);
    return true;
  }
  private event(stage: string, reason: string) {
    const r = this.request;
    if (r)
      this.store.previewEvent(`music_preview_${stage}`, {
        reason,
        trackId: r.track.id,
        group: r.group,
        volume: r.volume,
        owner: r.owner,
        operation: r.operation,
      });
  }
  submit(r: MusicPreviewRequest) {
    const now = this.now();
    for (const [owner, entry] of this.operations)
      if (entry.until < now) this.operations.delete(owner);
    if (r.expiresAt < now || r.expiresAt > now + 5000)
      throw new Error('music_preview_expired_request');
    const previous = this.operations.get(r.owner);
    if (previous && r.operation <= previous.operation)
      throw new Error('music_preview_stale_operation');
    if (!previous && this.operations.size >= 256) throw new Error('music_preview_busy');
    this.operations.set(r.owner, { operation: r.operation, until: now + 30_000 });
    const same = this.request?.owner === r.owner && this.request.token === r.token;
    if (r.action === 'stop') {
      if (same) {
        this.request = { ...this.request!, operation: r.operation };
        this.cancel('user_stop');
      }
      return;
    }
    if (r.action !== 'start') {
      if (same && (now >= this.lease || now >= this.deadline)) {
        this.cancel(now >= this.deadline ? 'deadline' : 'lease');
        return;
      }
      if (!same || this.stopping || !['playing', 'requested'].includes(this.status?.phase ?? ''))
        return;
      this.lease = now + 3000;
      // Lease renewals cannot overwrite a newer slider value.
      if (r.action === 'update') {
        const track = { ...this.request!.track };
        delete track.gain;
        this.request = {
          ...this.request!,
          track: { ...track, ...(r.track.gain === undefined ? {} : { gain: r.track.gain }) },
          volume: r.volume,
          operation: r.operation,
        };
      }
      return;
    }
    if (this.busy && (!same || this.status?.phase !== 'confirmation'))
      throw new Error('music_preview_busy');
    if (!this.store.ready || this.store.failure) throw new Error('music_preview_storage');
    this.request = r;
    this.failureMessage = null;
    this.revision++;
    this.stopping = false;
    this.stopSent = false;
    this.forceStop = false;
    this.lease = now + 3000;
    this.deadline = now + 15_000;
    this.status = {
      owner: r.owner,
      token: r.token,
      group: r.group,
      phase: 'requested',
      message: '正在核对 OBS 试听状态…',
    };
    this.event('requested', 'draft');
  }
  programPriority() {
    if (!this.request) return;
    if (this.uuid) this.cancel('formal_cue');
    else
      this.fail(
        'channel_busy',
        '当前音乐正在播放或已人工接管，请先使用“停止音乐”停止当前音乐，再试听。',
      );
  }
  cancel(reason: string) {
    if (!this.request) return;
    this.revision++;
    if (reason === 'explicit_stop') this.forceStop = true;
    if (reason === 'manual_control') {
      this.event('stopped', reason);
      this.request = null;
      this.uuid = null;
      this.stopping = false;
      this.status = {
        ...this.status!,
        phase: 'stopped',
        message: 'OBS 已人工接管试听，请在 OBS 检查或停止音效来源。',
      };
      return;
    }
    this.stopping = true;
    this.event(reason === 'deadline' || reason === 'lease' ? 'expired' : 'stop_requested', reason);
    this.status = {
      ...this.status!,
      phase: this.uuid ? 'cleanup' : 'stopped',
      message: this.uuid
        ? '试听停止未确认，正在等待 OBS。'
        : reason === 'program_safety'
          ? '比赛状态不允许试听，已停止。'
          : '试听已停止。',
    };
    if (!this.uuid) {
      this.event('stopped', 'not_started');
      this.request = null;
    }
  }
  confirmStopped(uuid: string): void {
    if (!this.stopping || this.uuid !== uuid) return;
    this.event('stopped', 'obs_stopped');
    this.uuid = null;
    this.request = null;
    this.stopping = false;
    this.status = { ...this.status!, phase: 'stopped', message: '试听已停止。' };
  }
  unavailable(error: unknown = new Error('music_obs_unavailable')) {
    if (
      !this.request ||
      (this.stopping &&
        this.status?.message === '试听停止未确认，请在 OBS 停止 音效来源；重连后优先清理。')
    )
      return;
    const hadMedia = Boolean(this.uuid);
    const failure = musicFailure(error);
    this.event('failed', failure.code);
    this.cancel(failure.code);
    this.status = {
      ...this.status!,
      phase: this.uuid ? 'cleanup' : 'failed',
      message: hadMedia
        ? '试听停止未确认，请在 OBS 停止 音效来源；重连后优先清理。'
        : failure.message,
    };
  }
  async reconcile(
    obs: MusicDevice,
    epoch: number,
    valid: () => boolean,
    safe: boolean,
    stopExpected: (uuid: string) => void,
    manual: () => Promise<void>,
  ) {
    if (!this.request) {
      await this.recoverMonitor(obs, valid);
      return;
    }
    if (!safe && !this.stopping) this.cancel('program_safety');
    if (this.now() >= this.deadline && !this.stopping) this.cancel('deadline');
    if (this.now() >= this.lease && !this.stopping) this.cancel('lease');
    if (!this.request) return;
    // A new OBS connection is cleanup only, never a queued audition start.
    if (this.uuid && epoch !== this.epoch && !this.stopping) this.cancel('obs_reconnected');
    if (this.stopping) {
      const revision = this.revision;
      const current = () => valid() && this.stopping && this.revision === revision;
      const name = await obs.findInput(this.store, 'stinger', current);
      if (!current()) return;
      if (name && this.store.state.sources.stinger === this.uuid) {
        const args = { inputUuid: this.uuid };
        const [settings, before, mute, volume] = await Promise.all([
          obs.inputSettings(args),
          obs.mediaStatus(args),
          obs.mute(args),
          obs.volume(args),
        ]);
        if (!current()) return;
        const mixerOwned = this.observeMixer(volume.inputVolumeMul, mute.inputMuted);
        if (
          !this.forceStop &&
          ((settings.inputSettings as Record<string, unknown>)?.local_file !== this.path ||
            !mixerOwned ||
            before.mediaState === 'OBS_MEDIA_STATE_PAUSED' ||
            (!this.stopSent && before.mediaState === 'OBS_MEDIA_STATE_STOPPED') ||
            (active(before.mediaState) &&
              Math.abs(Number(volume.inputVolumeMul) - this.expectedVolume) > 0.015))
        ) {
          this.uuid = null;
          this.request = null;
          this.status = {
            ...this.status!,
            phase: 'stopped',
            message: 'OBS 来源已被人工修改，试听已交还控制。',
          };
          await this.recoverMonitor(obs, valid);
          await manual();
          return;
        }
        const stopAlreadySent = this.stopSent;
        if (!stopAlreadySent) {
          stopExpected(this.uuid!);
          await obs.controlMedia({
            inputUuid: this.uuid,
            mediaAction: 'STOP',
          });
          if (!current()) return;
          this.stopSent = true;
        }
        const stopped = (state: unknown) =>
          [
            'OBS_MEDIA_STATE_STOPPED',
            'OBS_MEDIA_STATE_ENDED',
            'OBS_MEDIA_STATE_ERROR',
            'OBS_MEDIA_STATE_NONE',
          ].includes(String(state));
        let media = await obs.mediaStatus({ inputUuid: this.uuid });
        if (!current()) return;
        if (!stopped(media.mediaState) && stopAlreadySent) {
          stopExpected(this.uuid!);
          await obs.controlMedia({
            inputUuid: this.uuid,
            mediaAction: 'STOP',
          });
          if (!current()) return;
          media = await obs.mediaStatus({ inputUuid: this.uuid });
          if (!current()) return;
        }
        if (!stopped(media.mediaState)) return;
      }
      if (!current()) return;
      this.event('stopped', 'obs_stopped');
      this.uuid = null;
      this.request = null;
      this.status = {
        ...this.status!,
        phase: this.failureMessage ? 'failed' : 'stopped',
        message: this.failureMessage ?? '试听已停止。',
      };
      this.stopping = false;
      await this.recoverMonitor(obs, valid);
      return;
    }
    if (this.status?.phase === 'confirmation') return;
    const revision = this.revision;
    const current = () =>
      valid() &&
      revision === this.revision &&
      !this.stopping &&
      this.now() < this.lease &&
      this.now() < this.deadline;
    const device = obs.checkCalls(() => {
      if (!current()) throw new Error('music_cancelled');
    });
    const r = this.request;
    if (!this.uuid) {
      await this.recoverMonitor(obs, current);
      if (!current()) return;
      // Both owned layers must be idle. Never mix an audition with formal music or take control
      // of a paused/muted source; the operator can use the existing Stop music command first.
      for (const layer of ['bgm', 'stinger'] as const) {
        const name = await obs.findInput(this.store, layer, current);
        if (!name) continue;
        const args = { inputUuid: this.store.state.sources[layer] };
        const media = await device.mediaStatus(args);
        const mute = await device.mute(args);
        if (
          active(media.mediaState) ||
          media.mediaState === 'OBS_MEDIA_STATE_PAUSED' ||
          mute.inputMuted === true
        ) {
          this.fail(
            'channel_busy',
            '当前音乐正在播放或已人工接管，请先使用“停止音乐”停止当前音乐，再试听。',
          );
          return;
        }
      }
      const path = await this.store.trackPath(r.track.id).catch(() => null);
      if (!path) {
        this.fail('track_unavailable', '音频文件丢失或损坏，请重新选择。');
        return;
      }
      let quiet = false;
      try {
        quiet = await device.outputsStopped();
      } catch {
        /* Unknown output status requires explicit confirmation too. */
      }
      if (!current()) return;
      if (!quiet && !r.confirmed) {
        this.status = {
          ...this.status!,
          phase: 'confirmation',
          message: 'OBS 正在直播、录制或状态未知。试听会进入直播/录制，确认继续？',
        };
        this.lease = this.now() + 30_000;
        this.deadline = this.lease;
        return;
      }
      const name = await obs.findInput(this.store, 'stinger', current);
      if (!current()) return;
      if (!name) {
        this.fail('source_missing', 'OBS 音效来源尚未准备，请先准备音乐来源再试听。');
        return;
      }
      await obs.verifyPlayback(this.store, 'stinger', current);
      if (!current()) return;
      const uuid = this.store.state.sources.stinger!;
      const media = await device.mediaStatus({ inputUuid: uuid });
      const mute = await device.mute({ inputUuid: uuid });
      if (
        active(media.mediaState) ||
        media.mediaState === 'OBS_MEDIA_STATE_PAUSED' ||
        mute.inputMuted === true
      ) {
        this.fail(
          'channel_busy',
          '当前音乐正在播放或已人工接管，请先使用“停止音乐”停止当前音乐，再试听。',
        );
        return;
      }
      const gain = await device.volume({ inputUuid: uuid });
      if (typeof gain.inputVolumeMul !== 'number' || !Number.isFinite(gain.inputVolumeMul))
        throw new Error('music_preview_mixer_unconfirmed');
      // Register cleanup before the first write, including uncertain RPC outcomes.
      this.uuid = uuid;
      this.path = path;
      this.epoch = epoch;
      this.started = this.now();
      this.deadline = this.started + 15_000;
      this.expectedMuted = false;
      this.pendingVolume = null;
      this.pendingMute = null;
      this.envelope = 0;
      this.expectedVolume = gain.inputVolumeMul;
      await this.monitor.borrow(obs, uuid, current);
      // Remain silent until OBS confirms playback and the segment seek.
      await this.prepareMixer(obs, uuid, 0);
      await device.setVolume({ inputUuid: uuid, inputVolumeMul: 0 });
      this.confirmMixer(uuid, 0);
      await device.setInputSettings({
        inputUuid: uuid,
        overlay: true,
        inputSettings: {
          is_local_file: true,
          local_file: path,
          looping: false,
          restart_on_activate: false,
          close_when_inactive: false,
        },
      });
      await device.controlMedia({
        inputUuid: uuid,
        mediaAction: 'RESTART',
      });
      this.status = { ...this.status!, phase: 'requested', message: '正在等待 OBS 播放…' };
      return;
    }
    const args = { inputUuid: this.uuid };
    const media = await device.mediaStatus(args);
    const mute = await device.mute(args);
    const volume = await device.volume(args);
    const settings = await device.inputSettings(args);
    if (!current()) return;
    const mixerOwned = this.observeMixer(volume.inputVolumeMul, mute.inputMuted);
    if (
      !mixerOwned ||
      media.mediaState === 'OBS_MEDIA_STATE_PAUSED' ||
      media.mediaState === 'OBS_MEDIA_STATE_STOPPED' ||
      Math.abs(Number(volume.inputVolumeMul) - this.expectedVolume) > 0.015 ||
      (settings.inputSettings as Record<string, unknown>)?.local_file !== this.path
    ) {
      this.event('stopped', 'manual_control');
      this.uuid = null;
      this.request = null;
      this.revision++;
      this.status = {
        ...this.status!,
        phase: 'stopped',
        message: 'OBS 已人工接管试听，请在 OBS 检查或停止音效来源。',
      };
      await this.recoverMonitor(obs, valid);
      await manual();
      return;
    }
    if (
      media.mediaState === 'OBS_MEDIA_STATE_ERROR' ||
      media.mediaState === 'OBS_MEDIA_STATE_NONE'
    ) {
      this.fail('decode_failed', 'OBS 无法播放此音频，请重新选择。');
      return;
    }
    if (media.mediaState === 'OBS_MEDIA_STATE_ENDED') {
      this.cancel('natural_end');
      return;
    }
    if (media.mediaState !== 'OBS_MEDIA_STATE_PLAYING') {
      if (this.now() - this.started >= 2000)
        this.fail('start_timeout', 'OBS 未确认播放，请检查音效来源。');
      return;
    }
    const monitor = await this.monitor.observe(obs, this.uuid, current);
    if (!current()) return;
    if (!(await this.monitor.safe(obs, this.uuid, current))) {
      if (current()) this.cancel('monitor_changed');
      return;
    }
    if (this.status?.phase !== 'playing') {
      if (Number(media.mediaDuration) > 0 && r.track.startMs >= Number(media.mediaDuration)) {
        this.fail('segment_outside_media', '选段起点超出音频长度，请调整选段。');
        return;
      }
      this.fadeAt = this.now();
      if (r.track.startMs) await device.setMediaCursor({ ...args, mediaCursor: r.track.startMs });
      this.status = {
        ...this.status!,
        phase: 'playing',
        message: '正在通过 OBS 试听，最多 15 秒。',
      };
      this.event('started', 'obs_playing');
    }
    this.status = {
      ...this.status!,
      message:
        monitor === true
          ? 'OBS 已确认媒体播放和本机监听开启，最多 15 秒。'
          : monitor === false
            ? 'OBS 媒体正在播放，本机监听未开启；请为监听和桌面采集选择明确设备，监听设备不能被桌面采集。'
            : 'OBS 媒体正在播放，本机监听状态未确认；请在 OBS 核对。',
    };
    const cursor =
      this.status.phase === 'playing'
        ? Math.max(r.track.startMs, Number(media.mediaCursor) || 0)
        : r.track.startMs;
    const end = Math.min(
      r.track.endMs ?? Infinity,
      Number(media.mediaDuration) > 0 ? Number(media.mediaDuration) : Infinity,
    );
    if (cursor >= end) {
      this.cancel('segment_end');
      return;
    }
    const remaining = Math.min(this.deadline - this.now(), end - cursor);
    this.envelope = Math.min(
      1,
      r.fadeInMs ? (this.now() - this.fadeAt) / r.fadeInMs : 1,
      r.fadeOutMs ? Math.max(0, remaining) / r.fadeOutMs : 1,
    );
    const target = this.mixerVolume(this.uuid!)!;
    await this.prepareMixer(obs, this.uuid!, target);
    await device.setVolume({ ...args, inputVolumeMul: target });
    this.confirmMixer(this.uuid!, target);
  }
  private fail(reason: string, message: string) {
    this.failureMessage = message;
    this.event('failed', reason);
    this.cancel(reason);
    this.status = { ...this.status!, phase: this.uuid ? 'cleanup' : 'failed', message };
  }
}
