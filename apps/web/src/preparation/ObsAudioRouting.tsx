import { useState } from 'react';
import type { ObsAudioRole, ObsAudioRoutingStatus } from '@mizar/protocol/obs';
import { Button } from '../ui';

const labels: Record<ObsAudioRole, string> = {
  game: '游戏',
  remoteCommentary: '远端解说（TeamSpeak）',
  microphone: '麦克风',
};
export function ObsAudioRouting() {
  const [status, setStatus] = useState<ObsAudioRoutingStatus | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  async function refresh() {
    const response = await fetch('/local/v1/obs/audio-routing', { cache: 'no-store' });
    if (!response.ok) throw new Error('无法读取 OBS 音频来源，请检查连接。');
    setStatus((await response.json()) as ObsAudioRoutingStatus);
  }
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setMessage('');
    try {
      await action();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '操作未完成。');
    } finally {
      setBusy(false);
    }
  }
  async function bind(role: ObsAudioRole, selectionId: string | null) {
    if (!status) return;
    const response = await fetch('/operator/obs/audio-routing', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role, selectionId, revision: status.revision }),
    });
    if (!response.ok) {
      await refresh();
      throw new Error('来源或绑定已变化，请重新选择。');
    }
    setStatus((await response.json()) as ObsAudioRoutingStatus);
  }
  return (
    <div>
      <h3>音频分路绑定</h3>
      <p>从 OBS 已有来源明确选择；TeamSpeak 多个客户端需自行辨认。绑定不会修改来源、监听或音轨。</p>
      <Button disabled={busy} onClick={() => void run(refresh)}>
        刷新 OBS 音频来源
      </Button>
      {message && <p role="alert">{message}</p>}
      {status && (
        <>
          <p>
            当前 OBS：{status.endpoint}；场景集合：{status.collection}
          </p>
          {(Object.keys(labels) as ObsAudioRole[]).map((role) => (
            <div key={role}>
              <label htmlFor={`audio-${role}`}>{labels[role]}</label>{' '}
              <select
                id={`audio-${role}`}
                disabled={busy}
                value=""
                onChange={(event) => void run(() => bind(role, event.target.value || null))}
              >
                <option value="">选择来源或解除绑定</option>
                {status.candidates.map((candidate) => (
                  <option key={candidate.selectionId} value={candidate.selectionId}>
                    {candidate.name} · {candidate.kind} · {candidate.uuid}
                  </option>
                ))}
              </select>{' '}
              <Button
                disabled={busy || !status.bindings[role]}
                onClick={() => void run(() => bind(role, null))}
              >
                解除绑定
              </Button>
              <p>
                {status.bindings[role]
                  ? status.bindings[role]!.valid
                    ? `已绑定：${status.bindings[role]!.name}`
                    : '绑定来源不可用，请重新核对。'
                  : '尚未绑定'}
              </p>
            </div>
          ))}
          <ul>
            {status.findings.map((finding) => (
              <li key={finding}>{finding}</li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
