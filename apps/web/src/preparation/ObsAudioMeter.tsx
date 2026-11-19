import { useEffect, useRef, useState } from 'react';
import { Button } from '../ui';

type Reading = {
  durationMs: number;
  channels: {
    name: string;
    bound: boolean;
    muted: boolean | null;
    samples: number;
    peakDb: number | null;
    status: 'unavailable' | 'silent' | 'signal';
  }[];
};
export function ObsAudioMeter({
  mode,
  sourceNames,
}: {
  mode: 'desktop' | 'independent' | 'unknown';
  sourceNames: Readonly<Record<string, string | undefined>>;
}) {
  const [reading, setReading] = useState<Reading | null>(null);
  const [sampledAt, setSampledAt] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  async function sample() {
    if (pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setReading(null);
    setMessage('');
    try {
      const response = await fetch('/operator/obs/audio-meter', {
        method: 'POST',
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(12000)]),
      });
      if (!response.ok) throw new Error('电平检查未完成，请核对 OBS 连接与专用集合后重试。');
      const value = (await response.json()) as Reading;
      if (!controller.signal.aborted) {
        setReading(value);
        setSampledAt(new Date().toLocaleTimeString());
      }
    } catch (error) {
      if (!controller.signal.aborted)
        setMessage(error instanceof Error ? error.message : '电平检查未完成。');
    } finally {
      if (pending.current === controller) {
        pending.current = null;
        setBusy(false);
      }
    }
  }
  return (
    <section>
      <h3>节目声音</h3>
      <p>
        当前模式 ·{' '}
        {mode === 'desktop' ? '桌面混音' : mode === 'independent' ? '独立分路' : '未确认'}
      </p>
      <p>点击后采样约两秒，请同时说话或播放声音。只检查专用集合的固定音源，不改变音频配置。</p>
      <Button disabled={busy} aria-busy={busy} onClick={() => void sample()}>
        {busy ? '正在采样…' : '检查两秒输入电平'}
      </Button>
      {message && <p role="alert">{message}</p>}
      {reading && (
        <div role="status">
          <p>
            本次检测峰值 · {sampledAt} · {(reading.durationMs / 1000).toFixed(1)} 秒（非实时电平）
          </p>
          <ul>
            {reading.channels
              .filter(({ name, bound }) =>
                mode === 'desktop'
                  ? name !== '游戏声音' && name !== '其他解说'
                  : mode === 'independent'
                    ? name !== '桌面声音'
                    : bound,
              )
              .map((channel) => {
                const state = !channel.bound
                  ? '未找到受管来源'
                  : channel.muted === true
                    ? 'OBS 已静音'
                    : channel.status === 'unavailable'
                      ? '未收到电平数据'
                      : channel.status === 'silent'
                        ? '本次没有输入信号'
                        : `${channel.peakDb!.toFixed(1)} dBFS`;
                return (
                  <li key={channel.name} className="obs-program-audio-row">
                    <strong>{channel.name}</strong>
                    {sourceNames[channel.name] && <span>{sourceNames[channel.name]}</span>}
                    {channel.status !== 'unavailable' && channel.muted !== true ? (
                      <meter
                        min={-60}
                        max={0}
                        value={Math.max(-60, Math.min(0, channel.peakDb ?? -60))}
                        aria-label={`${channel.name}的采样峰值`}
                      />
                    ) : null}
                    <span>{state}</span>
                  </li>
                );
              })}
          </ul>
        </div>
      )}
      <p>峰值取自音量调整前的输入。请录制试听或监听平台，确认实际节目声音。</p>
    </section>
  );
}
