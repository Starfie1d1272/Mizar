import { useEffect, useRef, useState } from 'react';
import { Button } from '../ui';

type Reading = {
  durationMs: number;
  channels: {
    name: string;
    samples: number;
    peakDb: number | null;
    status: 'unavailable' | 'silent' | 'signal';
  }[];
};
export function ObsAudioMeter() {
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
      <h3>短时输入检查</h3>
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
            {reading.channels.map((channel) => (
              <li key={channel.name}>
                {channel.name}：
                {channel.status === 'unavailable'
                  ? '没有收到电平数据，无法判断'
                  : channel.status === 'silent'
                    ? '本次采样没有输入信号'
                    : `${channel.peakDb!.toFixed(1)} dBFS`}
              </li>
            ))}
          </ul>
        </div>
      )}
      <p>
        显示静音和音量调整前的输入峰值，不代表已进入播出音轨或平台有声；最终声音仍需录制或平台监听确认。
      </p>
    </section>
  );
}
