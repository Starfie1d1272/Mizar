import { useEffect, useState } from 'react';
import type { ObsAudioRole, ObsAudioRoutingStatus } from '@mizar/protocol/obs';
import { Button } from '../ui';

const labels: Record<ObsAudioRole, string> = {
  game: '游戏',
  remoteCommentary: '远端解说音频',
  microphone: '麦克风',
};
export function ObsAudioRouting() {
  const [commentary, setCommentary] = useState<{
    revision: string;
    preference: { mode: 'autoTeamspeak' | 'application' | 'existingInput' | 'disabled' };
  } | null>(null);
  const [status, setStatus] = useState<ObsAudioRoutingStatus | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  async function refreshCommentary() {
    const response = await fetch('/local/v1/obs/remote-commentary', { cache: 'no-store' });
    if (!response.ok) throw new Error('无法读取远端解说设置。');
    setCommentary((await response.json()) as typeof commentary);
  }
  useEffect(() => {
    void Promise.resolve()
      .then(() => fetch('/local/v1/obs/remote-commentary', { cache: 'no-store' }))
      .then((response) => {
        if (!response.ok) throw new Error('unavailable');
        return response.json();
      })
      .then((value: typeof commentary) => setCommentary(value))
      .catch(() => setMessage('无法读取远端解说设置。'));
  }, []);
  async function setMode(mode: 'autoTeamspeak' | 'disabled') {
    if (!commentary) return;
    const response = await fetch('/operator/obs/remote-commentary', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode, revision: commentary.revision }),
    });
    await refreshCommentary();
    if (!response.ok) throw new Error('设置未确认，请核对后重试。');
  }
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
      throw new Error('绑定结果未确认，请核对刷新后的状态再操作。');
    }
    try {
      await refresh();
      if (role === 'remoteCommentary') await refreshCommentary();
    } catch {
      setStatus(null);
      throw new Error('绑定已保存，但状态刷新失败；请重新读取 OBS 来源核对。');
    }
  }
  return (
    <div>
      <h3>远端解说音频</h3>
      <p>
        当前：
        {commentary
          ? (
              {
                autoTeamspeak: '自动识别 TeamSpeak',
                application: '已选择应用',
                existingInput: '已选择 OBS 来源',
                disabled: '已停用',
              } as const
            )[commentary.preference.mode]
          : '读取中'}
      </p>
      <Button
        disabled={busy || !commentary || commentary.preference.mode === 'autoTeamspeak'}
        onClick={() => void run(() => setMode('autoTeamspeak'))}
      >
        自动识别 TeamSpeak
      </Button>{' '}
      <Button
        disabled={busy || !commentary || commentary.preference.mode === 'disabled'}
        onClick={() => void run(() => setMode('disabled'))}
      >
        停用远端解说
      </Button>
      <p>音频分路完成前，新来源保持禁用；已有桌面声音保留。</p>
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
                  ? status.bindings[role].valid
                    ? `已绑定：${status.bindings[role].name}`
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
