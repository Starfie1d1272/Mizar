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
  onVolumeChange,
}: {
  compact?: boolean;
  volumeDisabled?: boolean;
  onVolumeChange?: (group: MusicGroup, volume: number) => void;
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
      if (body.action === 'volume')
        onVolumeChange?.(body.group as MusicGroup, body.volume as number);
    } catch {
      setError('音乐操作未完成，请检查本机服务与 OBS 后重试。');
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
  return (
    <div
      className={compact ? 'music-controls music-controls--compact' : 'music-controls'}
      aria-label="现场音乐"
    >
      <span className="music-controls__track" title={status.bgm?.track}>
        {status.held
          ? '音乐 · 手动停止'
          : status.bgm
            ? `${MUSIC_LABELS[status.bgm.group]} · ${status.bgm.track}`
            : '音乐 · 静音'}
        {status.stinger ? ` · 音效 ${status.stinger}` : ''}
      </span>
      {!compact ? (
        <>
          <Select
            label="正式播放曲目"
            value={selection}
            disabled={busy || volumeDisabled}
            onChange={(e) => setSelection(e.target.value)}
          >
            <option value="">选择已保存曲目</option>
            {Object.entries(view.config.groups).flatMap(([group, spec]) =>
              group !== 'opening' && spec.enabled
                ? spec.tracks.map((track) => (
                    <option key={`${group}:${track.id}`} value={`${group}:${track.id}`}>
                      {MUSIC_LABELS[group as MusicGroup]} · {track.name}
                    </option>
                  ))
                : [],
            )}
          </Select>
          <Button
            disabled={busy || volumeDisabled || !selection}
            onClick={() => {
              const [group, trackId] = selection.split(':');
              void send({ action: 'play', group, trackId });
            }}
          >
            播放所选
          </Button>
          <Button
            disabled={
              busy || status.intent !== 'manual' || !['playing', 'paused'].includes(status.playback)
            }
            onClick={() =>
              void send({ action: status.playback === 'paused' ? 'continue' : 'pause' })
            }
          >
            {status.playback === 'paused' ? '继续播放' : '暂停'}
          </Button>
          <span role="status">
            {status.intent === 'manual'
              ? '人工播放'
              : status.intent === 'held'
                ? '手动停止'
                : '自动编排'}{' '}
            · OBS：
            {status.playback === 'playing'
              ? '播放中'
              : status.playback === 'paused'
                ? '已暂停'
                : status.playback === 'stopped'
                  ? '已停止'
                  : '状态未知'}
          </span>
        </>
      ) : null}
      {!compact && status.bgm ? (
        <>
          <span>
            {musicTime(seekDraft?.cursorMs ?? status.cursorMs)} / {musicTime(status.durationMs)}
          </span>
          <Field
            label="播放进度"
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
        </>
      ) : null}
      {!compact ? (
        <>
          <Button
            disabled={busy}
            onClick={() => void send({ action: 'monitor', enabled: status.monitor !== 'enabled' })}
          >
            {status.monitor === 'enabled' ? '关闭本机监听' : '开启本机监听'}
          </Button>
          <span role="status">
            监听：
            {status.monitor === 'enabled'
              ? '已开启'
              : status.monitor === 'disabled'
                ? '已关闭'
                : status.monitor === 'mixed'
                  ? '部分开启'
                  : '状态未知'}
            。使用 OBS 所在机器的监听设备；桌面采集可能回灌。
          </span>
        </>
      ) : null}
      {status.bgm ? (
        <Field
          label={compact ? '' : '当前播放音量'}
          aria-label="音乐音量"
          disabled={busy || volumeDisabled}
          type="range"
          min="0"
          max="1"
          step="0.05"
          value={status.bgm.volume}
          onChange={(e) => {
            void send({
              action: 'volume',
              group: status.bgm!.group,
              volume: Number(e.target.value),
            });
          }}
        />
      ) : null}
      <Button disabled={busy} aria-label="停止音乐" onClick={() => void send({ action: 'stop' })}>
        {compact ? '停止' : '停止音乐'}
      </Button>
      <Button
        disabled={
          busy || status.held || !status.bgm || !['waiting', 'technical'].includes(status.bgm.group)
        }
        onClick={() => void send({ action: 'next' })}
      >
        下一首
      </Button>
      {status.held || status.intent === 'manual' ? (
        <Button
          aria-label="恢复自动音乐"
          disabled={busy}
          onClick={() => void send({ action: 'resume' })}
        >
          {compact ? '恢复自动' : '恢复自动音乐'}
        </Button>
      ) : null}
      {error ? <span role="alert">{error}</span> : null}
      {status.message ? <span role="status">{status.message}</span> : null}
    </div>
  );
}
