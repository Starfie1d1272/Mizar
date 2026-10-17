import './music.css';
import { useState } from 'react';
import type { MusicConfig, MusicStatus } from '@mizar/protocol/music';
import { Button, Field } from '../ui';
import { useLocalRead, command } from '../preparation/client';

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
export function MusicControls({ compact = false }: { compact?: boolean }) {
  const view = useLocalRead<MusicView>('/local/v1/music', 1000);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const send = async (body: Record<string, unknown>) => {
    setBusy(true);
    setError('');
    try {
      await command('/operator/music', body);
    } catch {
      setError('音乐操作未完成，请检查本机服务与 OBS 后重试。');
    } finally {
      setBusy(false);
    }
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
      {status.bgm ? (
        <Field
          label={compact ? '' : '音乐音量'}
          aria-label={compact ? '' : '音乐音量'}
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
      <Button aria-label="停止音乐" onClick={() => void send({ action: 'stop' })}>
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
      {status.held ? (
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
