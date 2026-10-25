import type { MusicPreviewRequest, MusicPreviewStatus } from '@mizar/protocol/music';
import type { ObsRpc } from '../obs/reconcile.js';
import { ownedMusicInput } from './obs-provider.js';
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
  private epoch = 0;
  private stopping = false;
  constructor(
    private readonly store: MusicStore,
    private readonly now: () => number,
  ) {}
  get busy() {
    return Boolean(this.request || this.uuid);
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
      if (!same || this.stopping || !['playing', 'requested'].includes(this.status?.phase ?? ''))
        return;
      this.lease = now + 3000;
      // Lease renewals cannot overwrite a newer slider value.
      if (r.action === 'update')
        this.request = { ...this.request!, volume: r.volume, operation: r.operation };
      return;
    }
    if (this.busy && (!same || this.status?.phase !== 'confirmation'))
      throw new Error('music_preview_busy');
    if (!this.store.ready || this.store.failure) throw new Error('music_preview_storage');
    this.request = r;
    this.revision++;
    this.stopping = false;
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
  cancel(reason: string) {
    if (!this.request) return;
    this.revision++;
    this.stopping = true;
    this.event(reason === 'deadline' || reason === 'lease' ? 'expired' : 'stop_requested', reason);
    this.status = {
      ...this.status!,
      phase: this.uuid ? 'cleanup' : 'stopped',
      message: reason === 'program_safety' ? '比赛状态不允许试听，已停止。' : '试听已停止。',
    };
    if (!this.uuid) {
      this.event('stopped', 'not_started');
      this.request = null;
    }
  }
  unavailable() {
    if (!this.request) return;
    this.event('failed', 'obs_disconnected');
    this.cancel('obs_disconnected');
    this.status = {
      ...this.status!,
      phase: this.uuid ? 'cleanup' : 'failed',
      message: '试听停止未确认，请在 OBS 停止 Mizar 音效来源；重连后优先清理。',
    };
  }
  async reconcile(
    obs: ObsRpc,
    epoch: number,
    valid: () => boolean,
    safe: boolean,
    stopExpected: (uuid: string) => void,
    manual: () => Promise<void>,
  ) {
    if (!this.request) return;
    if (!safe && !this.stopping) this.cancel('program_safety');
    if (this.now() >= this.deadline && !this.stopping) this.cancel('deadline');
    if (this.now() >= this.lease && !this.stopping) this.cancel('lease');
    if (!this.request) return;
    // A new OBS connection is cleanup only, never a queued audition start.
    if (this.uuid && epoch !== this.epoch && !this.stopping) this.cancel('obs_reconnected');
    if (this.stopping) {
      const name = await ownedMusicInput(obs, this.store, 'stinger', false, () => true, false);
      if (name && this.store.state.sources.stinger === this.uuid) {
        const settings = await obs.call('GetInputSettings', { inputUuid: this.uuid });
        if ((settings.inputSettings as Record<string, unknown>)?.local_file !== this.path) {
          this.uuid = null;
          this.request = null;
          this.status = {
            ...this.status!,
            phase: 'stopped',
            message: 'OBS 来源已被人工修改，试听已交还控制。',
          };
          await manual();
          return;
        }
        stopExpected(this.uuid!);
        await obs.call('TriggerMediaInputAction', {
          inputUuid: this.uuid,
          mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_STOP',
        });
      }
      this.event('stopped', 'obs_stop_acknowledged');
      this.uuid = null;
      this.request = null;
      this.status = {
        ...this.status!,
        phase: this.status?.message === '试听已停止。' ? 'stopped' : 'failed',
      };
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
    const call = (type: string, data?: Record<string, unknown>) => {
      if (!current()) throw new Error('music_cancelled');
      return obs.call(type, data);
    };
    const r = this.request;
    if (!this.uuid) {
      const path = await this.store.trackPath(r.track.id).catch(() => null);
      if (!path) {
        this.fail('track_unavailable', '音频文件丢失或损坏，请重新选择。');
        return;
      }
      let quiet = false;
      try {
        const stream = await call('GetStreamStatus');
        const record = await call('GetRecordStatus');
        quiet = stream.outputActive === false && record.outputActive === false;
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
      const name = await ownedMusicInput(obs, this.store, 'stinger', true, current, true, true);
      if (!name || !current()) return;
      const uuid = this.store.state.sources.stinger!;
      const media = await call('GetMediaInputStatus', { inputUuid: uuid });
      const mute = await call('GetInputMute', { inputUuid: uuid });
      if (
        active(media.mediaState) ||
        media.mediaState === 'OBS_MEDIA_STATE_PAUSED' ||
        mute.inputMuted === true
      ) {
        this.fail('channel_busy', 'OBS 音效来源正在播放或已人工接管，请先在 OBS 检查。');
        return;
      }
      // Register cleanup before the first write, including uncertain RPC outcomes.
      this.uuid = uuid;
      this.path = path;
      this.epoch = epoch;
      this.started = this.now();
      this.deadline = this.started + 15_000;
      this.expectedVolume = 0; // Remain silent until OBS confirms playback and the segment seek.
      await call('SetInputVolume', { inputUuid: uuid, inputVolumeMul: this.expectedVolume });
      await call('SetInputSettings', {
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
      await call('TriggerMediaInputAction', {
        inputUuid: uuid,
        mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART',
      });
      this.status = { ...this.status!, phase: 'requested', message: '正在等待 OBS 播放…' };
      return;
    }
    const args = { inputUuid: this.uuid };
    const media = await call('GetMediaInputStatus', args);
    const mute = await call('GetInputMute', args);
    const volume = await call('GetInputVolume', args);
    const settings = await call('GetInputSettings', args);
    if (!current()) return;
    if (
      mute.inputMuted === true ||
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
    if (this.status?.phase !== 'playing') {
      if (Number(media.mediaDuration) > 0 && r.track.startMs >= Number(media.mediaDuration)) {
        this.fail('segment_outside_media', '选段起点超出音频长度，请调整选段。');
        return;
      }
      this.fadeAt = this.now();
      if (r.track.startMs)
        await call('SetMediaInputCursor', { ...args, mediaCursor: r.track.startMs });
      this.status = {
        ...this.status!,
        phase: 'playing',
        message: '正在通过 OBS 试听，最多 15 秒。',
      };
      this.event('started', 'obs_playing');
    }
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
    this.expectedVolume =
      r.volume *
      Math.min(
        1,
        r.fadeInMs ? (this.now() - this.fadeAt) / r.fadeInMs : 1,
        r.fadeOutMs ? Math.max(0, remaining) / r.fadeOutMs : 1,
      );
    await call('SetInputVolume', { ...args, inputVolumeMul: this.expectedVolume });
  }
  private fail(reason: string, message: string) {
    this.event('failed', reason);
    this.cancel(reason);
    this.status = { ...this.status!, phase: this.uuid ? 'cleanup' : 'failed', message };
  }
}
