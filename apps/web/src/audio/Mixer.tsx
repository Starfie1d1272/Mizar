import './mixer.css';
import { useRef, useState } from 'react';
import { useLocalRead } from '../preparation/client';
import { Button } from '../ui';

type Channel = 'game' | 'remoteCommentary' | 'microphone' | 'music';
type MixerState = {
  revision: string;
  channels: Record<
    Channel,
    {
      name: string;
      volume: number | null;
      muted: boolean | null;
      control: 'available' | 'unbound' | 'unknown' | 'held';
      message?: string;
    }
  >;
};
const labels: Record<Channel, string> = {
  game: '游戏',
  remoteCommentary: '其他解说',
  microphone: '麦克风',
  music: '音乐',
};
const channels: Channel[] = ['game', 'remoteCommentary', 'microphone', 'music'];

export function Mixer({ musicOnly = false }: { musicOnly?: boolean }) {
  const [refresh, setRefresh] = useState(0);
  const state = useLocalRead<MixerState>('/local/v1/mixer', 2000, refresh);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState<{ channel: Channel; volume: number } | null>(null);
  async function update(channel: Channel, change: { volume?: number; muted?: boolean }) {
    if (!state || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/operator/mixer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ revision: state.revision, channel, ...change }),
        signal: AbortSignal.timeout(15000),
      });
      const result = (await response.json()) as {
        status?: 'confirmed' | 'rejected' | 'unknown';
        message?: string;
      };
      if (!response.ok || result.status !== 'confirmed')
        setError(
          result.message ??
            (result.status === 'unknown' ? '结果未确认，请核对 OBS。' : '操作未完成，请核对状态。'),
        );
    } catch {
      setError('操作结果未确认，请核对 OBS。');
    } finally {
      setDraft(null);
      setRefresh((value) => value + 1);
      inFlight.current = false;
      setBusy(false);
    }
  }
  return (
    <section
      className={`audio-mixer${musicOnly ? ' audio-mixer--music' : ''}`}
      aria-label={musicOnly ? '音乐总控' : '音频混音'}
    >
      {!musicOnly && (
        <div className="audio-mixer__heading">
          <h2>音频混音</h2>
          <span>调整节目输出音量</span>
        </div>
      )}
      <div className="audio-mixer__channels">
        {(musicOnly ? (['music'] as Channel[]) : channels).map((channel) => {
          const item = state?.channels[channel];
          const available =
            item?.control === 'available' && item.volume !== null && item.muted !== null;
          const value = draft?.channel === channel ? draft.volume : item?.volume;
          const label = labels[channel];
          const status =
            item?.control === 'held'
              ? '手动'
              : item?.control === 'unbound'
                ? '未绑定'
                : item?.control === 'available'
                  ? item.muted
                    ? '已静音'
                    : '已连接'
                  : '待确认';
          const commit = () => {
            if (draft?.channel === channel) void update(channel, { volume: draft.volume });
          };
          return (
            <div className="audio-mixer__channel" key={channel}>
              <div className="audio-mixer__title">
                <strong>{label}</strong>
                <span>{status}</span>
              </div>
              <div className="audio-mixer__control">
                <input
                  type="range"
                  aria-label={`${label}音量`}
                  min="0"
                  max="1"
                  step="0.01"
                  value={value ?? 0}
                  disabled={busy || !available}
                  onChange={(event) => setDraft({ channel, volume: Number(event.target.value) })}
                  onPointerUp={commit}
                  onKeyUp={commit}
                  onBlur={commit}
                />
                <output>{value == null ? '—' : `${Math.round(value * 100)}%`}</output>
                <Button
                  disabled={busy || !available}
                  aria-label={`${item?.muted ? '取消' : ''}静音${label}`}
                  onClick={() => void update(channel, { muted: !item!.muted })}
                >
                  {item?.muted ? '取消静音' : '静音'}
                </Button>
              </div>
              {item?.control === 'held' && (
                <small>
                  {channel === 'music'
                    ? '请在音乐页核对 OBS，并使用“恢复自动音乐”。'
                    : channel === 'game'
                      ? '请核对 OBS；中场让权时可在音频设置恢复自动控制。'
                      : '请在 OBS 核对来源和音量。'}
                </small>
              )}
              {item?.message && <small>{item.message}</small>}
            </div>
          );
        })}
      </div>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
