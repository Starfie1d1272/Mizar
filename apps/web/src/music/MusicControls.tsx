import './music.css';
import { useState } from 'react';
import type { MusicConfig, MusicGroup, MusicStatus } from '@mizar/protocol/music';
import { Button, Field, Select } from '../ui';
import { useLocalRead, command } from '../preparation/client';

function musicTime(ms: number | null) {
  if (ms === null || !Number.isFinite(ms)) return '--:--';
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

export interface MusicView {
  storage?: { ready: boolean; failed: boolean };
  config: MusicConfig;
  status: MusicStatus;
}
export const MUSIC_LABELS = {
  waiting: '等待音乐',
  tactical: '战术暂停',
  technical: '技术暂停',
  halftime: '中场',
  mapVictory: '单图胜利',
  matchVictory: '整场胜利',
  opening: '开场短音效',
} as const;
export function MusicControls({
  compact = false,
  volumeDisabled = false,
}: {
  compact?: boolean;
  volumeDisabled?: boolean;
}) {
  const view = useLocalRead<MusicView>('/local/v1/music', 1000);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [selection, setSelection] = useState('');
  const [seekDraft, setSeekDraft] = useState<{ cursorMs: number; playbackId: string } | null>(null);
  const send = async (body: Record<string, unknown>) => {
    setBusy(true);
    setError('');
    try {
      await command('/operator/music', body);
      if (body.action === 'play') setSelection('');
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : '音乐操作未完成，请检查本机服务与 OBS 后重试。',
      );
    } finally {
      setBusy(false);
    }
  };
  const commitSeek = () => {
    if (seekDraft === null) return;
    setSeekDraft(null);
    void send({ action: 'seek', ...seekDraft });
  };
  const status = view?.status;
  if (!status) return null;
  const trackTitle = status.bgm?.track ?? (status.held ? '音乐已停止' : '当前无音乐');
  const nextDisabled =
    busy || status.held || !status.bgm || !['waiting', 'technical'].includes(status.bgm.group);
  const volume = status.bgm ? (
    <Field
      label=""
      aria-label="音乐音量"
      disabled={busy || volumeDisabled}
      type="range"
      min="0"
      max="1"
      step="0.05"
      value={view.config.groups[status.bgm.group].volume}
      onChange={(event) =>
        void send({
          action: 'volume',
          group: status.bgm!.group,
          volume: Number(event.target.value),
        })
      }
    />
  ) : null;
  const stop = (
    <Button disabled={busy} aria-label="停止音乐" onClick={() => void send({ action: 'stop' })}>
      {compact ? '停止' : '停止音乐'}
    </Button>
  );
  const next = (
    <Button disabled={nextDisabled} onClick={() => void send({ action: 'next' })}>
      下一首
    </Button>
  );
  const resume =
    status.held || (!compact && status.intent === 'manual') ? (
      <Button
        aria-label="恢复自动音乐"
        className={compact ? undefined : 'music-player__resume'}
        disabled={busy}
        onClick={() => void send({ action: 'resume' })}
      >
        {compact ? '恢复自动' : '恢复自动音乐'}
      </Button>
    ) : null;
  const notices = (
    <>
      {error ? <span role="alert">{error}</span> : null}
      {status.message ? <span role="status">{status.message}</span> : null}
    </>
  );
  if (compact)
    return (
      <div className="music-controls music-controls--compact" aria-label="现场音乐">
        <span className="music-controls__track" title={status.bgm?.track}>
          {status.held
            ? '音乐 · 手动停止'
            : status.bgm
              ? `${MUSIC_LABELS[status.bgm.group]} · ${status.bgm.track}`
              : '音乐 · 静音'}
          {status.stinger ? ` · 音效 ${status.stinger}` : ''}
        </span>
        {volume}
        {stop}
        {next}
        {resume}
        {notices}
      </div>
    );
  const canPause = status.intent === 'manual' && ['playing', 'paused'].includes(status.playback);
  const primaryLabel = selection
    ? '播放所选'
    : status.playback === 'paused' && canPause
      ? '继续播放'
      : canPause
        ? '暂停'
        : '播放';
  const playbackLabel =
    status.playback === 'playing'
      ? '播放中'
      : status.playback === 'paused'
        ? '已暂停'
        : status.playback === 'stopped'
          ? '已停止'
          : '状态未知';
  const monitorLabel =
    status.monitor === 'enabled'
      ? '已开启'
      : status.monitor === 'disabled'
        ? '已关闭'
        : status.monitor === 'mixed'
          ? '部分开启'
          : '状态未知';
  return (
    <div className="music-player" aria-label="现场音乐">
      <div className="music-player__main">
        <div className="music-player__heading">
          <strong className="music-controls__track" title={trackTitle}>
            {trackTitle}
          </strong>
          <span role="status">
            {status.intent === 'manual'
              ? '人工播放'
              : status.intent === 'held'
                ? '手动停止'
                : '自动编排'}{' '}
            · OBS：{playbackLabel}
          </span>
        </div>
        <div className="music-player__progress">
          <span>{musicTime(seekDraft?.cursorMs ?? status.cursorMs)}</span>
          <Field
            label="播放进度"
            aria-label="播放进度"
            type="range"
            min={status.segmentStartMs ?? 0}
            max={Math.max(
              status.segmentStartMs ?? 0,
              Math.min(status.segmentEndMs ?? Infinity, status.durationMs ?? 0) - 1,
            )}
            step="1"
            value={seekDraft?.cursorMs ?? status.cursorMs ?? 0}
            disabled={
              busy ||
              !status.bgm ||
              status.cursorMs === null ||
              !status.durationMs ||
              !['playing', 'paused'].includes(status.playback)
            }
            onChange={(e) =>
              setSeekDraft({ cursorMs: Number(e.target.value), playbackId: status.bgm!.playbackId })
            }
            onPointerUp={commitSeek}
            onKeyUp={commitSeek}
            onBlur={commitSeek}
          />
          <span>{musicTime(status.durationMs)}</span>
        </div>
        <div className="music-player__actions">
          <Button
            variant="primary"
            disabled={busy || (selection ? volumeDisabled : !canPause)}
            onClick={() => {
              if (selection) {
                const [group, entryId] = selection.split(':');
                void send({ action: 'play', group, entryId });
              } else void send({ action: status.playback === 'paused' ? 'continue' : 'pause' });
            }}
          >
            {primaryLabel}
          </Button>
          {next}
          {stop}
          {resume}
        </div>
      </div>
      <div className="music-player__side">
        <Select
          label="正式播放曲目"
          value={selection}
          disabled={busy || volumeDisabled}
          onChange={(e) => setSelection(e.target.value)}
        >
          <option value="">选择已保存曲目</option>
          {Object.entries(view.config.groups).flatMap(([group, spec]) =>
            group !== 'opening' && spec.enabled
              ? spec.tracks
                  .filter((track) => track.entryId)
                  .map((track) => (
                    <option key={`${group}:${track.entryId}`} value={`${group}:${track.entryId}`}>
                      {MUSIC_LABELS[group as MusicGroup]} · {track.name}
                    </option>
                  ))
              : [],
          )}
        </Select>
        <div className="music-player__monitor">
          <Button
            disabled={busy}
            onClick={() => void send({ action: 'monitor', enabled: status.monitor !== 'enabled' })}
          >
            {status.monitor === 'enabled' ? '关闭本机监听' : '开启本机监听'}
          </Button>
          <span role="status">监听：{monitorLabel}</span>
        </div>
      </div>
      <p className="music-player__hint">使用 OBS 所在机器的监听设备；桌面采集可能回灌。</p>
      {status.stinger ? <span className="music-player__hint">音效：{status.stinger}</span> : null}
      <div className="music-player__notices">{notices}</div>
    </div>
  );
}
