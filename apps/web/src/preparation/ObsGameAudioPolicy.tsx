import { useEffect, useState } from 'react';
import { Button } from '../ui';
type Policy = { mode: 'keep' | 'mute' } | { mode: 'attenuate'; db: number };
type Status = { ready: boolean; policy: Policy; ownership: 'idle' | 'intent' | 'owned' | 'held' };
export function ObsGameAudioPolicy() {
  const [status, setStatus] = useState<Status | null>(null);
  const [mode, setMode] = useState<Policy['mode']>('keep');
  const [db, setDb] = useState(6);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  async function refresh() {
    const response = await fetch('/local/v1/obs/game-audio-policy', { cache: 'no-store' });
    if (!response.ok) throw new Error('无法读取中场音频设置。');
    const next = (await response.json()) as Status;
    setStatus(next);
    if (next.ready) {
      setMode(next.policy.mode);
      if (next.policy.mode === 'attenuate') setDb(next.policy.db);
    }
  }
  useEffect(() => {
    void refresh().catch(() => setMessage('无法读取中场音频设置。'));
    const timer = setInterval(() => {
      void fetch('/local/v1/obs/game-audio-policy', { cache: 'no-store' })
        .then((response) => (response.ok ? response.json() : null))
        .then((next: Status | null) => {
          if (next) setStatus(next);
        })
        .catch(() => undefined);
    }, 2000);
    return () => clearInterval(timer);
  }, []);
  async function send(path: string, body: unknown) {
    setBusy(true);
    setMessage('');
    try {
      const response = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error('操作未确认，请重新核对。');
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '操作未完成。');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div>
      <h3>中场游戏音频</h3>
      <p>仅作用于已绑定的游戏来源；默认保持不变。请在 OBS 核对实际声音。</p>
      <label htmlFor="game-audio-policy">中场策略</label>{' '}
      <select
        id="game-audio-policy"
        value={mode}
        disabled={busy || !status?.ready}
        onChange={(e) => setMode(e.target.value as Policy['mode'])}
      >
        <option value="keep">保持</option>
        <option value="attenuate">降低音量</option>
        <option value="mute">静音</option>
      </select>
      {mode === 'attenuate' && (
        <label>
          {' '}
          降低 dB{' '}
          <input
            type="number"
            min="0.1"
            max="60"
            step="0.1"
            value={db}
            onChange={(e) => setDb(Number(e.target.value))}
          />
        </label>
      )}
      <Button
        disabled={busy || !status?.ready || (mode === 'attenuate' && !(db > 0 && db <= 60))}
        onClick={() =>
          void send(
            '/operator/obs/game-audio-policy',
            mode === 'attenuate' ? { mode, db } : { mode },
          )
        }
      >
        保存中场策略
      </Button>
      {status?.ownership === 'held' && (
        <p role="status">
          OBS 音频控制已让权。请在比赛恢复后先在 OBS 手动恢复游戏音量与静音状态，然后{' '}
          <Button disabled={busy} onClick={() => void send('/operator/obs/game-audio-release', {})}>
            恢复自动控制
          </Button>
          。
        </p>
      )}
      {message && <p role="alert">{message}</p>}
    </div>
  );
}
