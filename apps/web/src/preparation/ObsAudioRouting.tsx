import { useEffect, useState } from 'react';
import type { ObsAudioRole, ObsAudioRoutingStatus } from '@mizar/protocol/obs';
import { Button, Select } from '../ui';

const labels: Record<ObsAudioRole, string> = {
  game: '游戏',
  remoteCommentary: '远端解说音频',
  microphone: '麦克风',
};
const sourceTypes: Record<string, string> = {
  wasapi_output_capture: '桌面音频',
  wasapi_input_capture: '音频输入',
  wasapi_process_output_capture: '应用音频',
  game_capture: '游戏捕获',
  window_capture: '窗口捕获',
};
export function ObsAudioRouting() {
  const [commentary, setCommentary] = useState<{
    revision: string;
    preference: {
      mode: 'autoTeamspeak' | 'application' | 'existingInput' | 'disabled';
      window?: string;
    };
  } | null>(null);
  const [status, setStatus] = useState<ObsAudioRoutingStatus | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [applications, setApplications] = useState<{
    revision: string;
    candidates: { id: string; label: string }[];
  } | null>(null);
  const [application, setApplication] = useState('');
  const [desktopSelection, setDesktopSelection] = useState('');
  async function refreshCommentary() {
    const response = await fetch('/local/v1/obs/remote-commentary', { cache: 'no-store' });
    if (!response.ok) throw new Error('无法读取远端解说设置。');
    setCommentary((await response.json()) as typeof commentary);
  }
  useEffect(() => {
    void refresh().catch(() => setMessage('无法读取 OBS 音频来源，请检查连接。'));
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
    setApplications(null);
    setApplication('');
    if (mode === 'autoTeamspeak') await prepareCommentary();
  }
  async function listApplications() {
    const response = await fetch('/operator/obs/remote-commentary/applications', {
      method: 'POST',
    });
    if (!response.ok)
      throw new Error(
        '无法读取应用窗口；请确认 OBS 已连接、场景已准备。首次读取可能需要停止输出。',
      );
    setApplications((await response.json()) as NonNullable<typeof applications>);
    setApplication('');
  }
  async function selectApplication() {
    if (!applications || !application) return;
    const response = await fetch('/operator/obs/remote-commentary/application', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ revision: applications.revision, selectionId: application }),
    });
    if (!response.ok) throw new Error('应用列表已变化，请重新读取并选择。');
    setApplications(null);
    setApplication('');
    await refreshCommentary();
    await prepareCommentary();
  }
  async function prepareCommentary() {
    const configured = await fetch('/operator/obs/ensure', { method: 'POST' });
    if (!configured.ok) throw new Error('应用选择已保存，场景配置待处理。');
    const result = (await configured.json()) as { findings: { code: string; message: string }[] };
    const pending =
      result.findings.find((finding) => finding.code === 'commentary_pending') ??
      result.findings[0];
    setMessage(pending?.message ?? '应用选择已保存，场景音频已准备。');
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
  async function switchMode(selectionId: string | null) {
    if (!status) return;
    const response = await fetch('/operator/obs/audio-mode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ revision: status.revision, selectionId }),
    });
    if (!response.ok) {
      const result = (await response.json()) as { message?: string };
      await refresh().catch(() => undefined);
      throw new Error(result.message ?? '切换未确认，请检查 OBS。');
    }
    await refresh();
    setDesktopSelection('');
    setMessage(selectionId ? '已切换桌面混音。请录制试听。' : '已切换独立分路。请录制试听。');
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
      <h3>音频模式</h3>
      <p>
        桌面混音包含游戏与其他解说，无法分别调节；麦克风仍单独控制，本机监听的音乐也可能进入混音。
      </p>
      <p>TeamSpeak 6 beta5 的应用捕获可能只有提示音，请核对版本并录制真人语音试听。</p>
      <Button disabled={busy} onClick={() => void run(refresh)}>
        读取 OBS 音频来源
      </Button>
      {status && (
        <>
          <p>
            当前模式：
            {status.transition
              ? '切换待完成，请重新选择并切换'
              : status.desktop
                ? '桌面混音'
                : '独立分路'}
          </p>
          <Select
            label="桌面音频来源"
            value={desktopSelection}
            disabled={busy}
            onChange={(event) => setDesktopSelection(event.target.value)}
          >
            <option value="">请选择 OBS 桌面音频来源</option>
            {status.candidates
              .filter((candidate) => candidate.kind === 'wasapi_output_capture')
              .map((candidate) => (
                <option key={candidate.selectionId} value={candidate.selectionId}>
                  {candidate.name}
                </option>
              ))}
          </Select>{' '}
          <Button
            disabled={busy || !desktopSelection}
            onClick={() => void run(() => switchMode(desktopSelection))}
          >
            切换桌面混音
          </Button>{' '}
          <Button
            disabled={busy || (!status.desktop && !status.transition)}
            onClick={() => void run(() => switchMode(null))}
          >
            切回独立分路
          </Button>
        </>
      )}
      <h3>远端解说音频</h3>
      <p className="obs-audio-commentary-current">
        当前：
        {commentary
          ? (
              {
                autoTeamspeak: '自动识别 TeamSpeak',
                application: commentary.preference.window
                  ? `已选择应用：${commentary.preference.window.split(':')[0]!.replaceAll('#3A', ':').replaceAll('#22', '#')}`
                  : '已选择应用',
                existingInput: '已选择 OBS 来源',
                disabled: '已停用',
              } as const
            )[commentary.preference.mode]
          : '读取中'}
      </p>
      <Button
        disabled={
          busy ||
          Boolean(status?.desktop || status?.transition) ||
          !commentary ||
          commentary.preference.mode === 'autoTeamspeak'
        }
        onClick={() => void run(() => setMode('autoTeamspeak'))}
      >
        自动识别 TeamSpeak
      </Button>{' '}
      <Button
        disabled={
          busy ||
          Boolean(status?.desktop || status?.transition) ||
          !commentary ||
          commentary.preference.mode === 'disabled'
        }
        onClick={() => void run(() => setMode('disabled'))}
      >
        停用远端解说
      </Button>{' '}
      <Button
        disabled={busy || Boolean(status?.desktop || status?.transition)}
        onClick={() => void run(listApplications)}
      >
        选择其他应用
      </Button>
      {applications && (
        <div className="obs-audio-application-choice">
          <Select
            label="应用窗口"
            value={application}
            disabled={busy}
            onChange={(event) => setApplication(event.target.value)}
          >
            <option value="">请选择应用</option>
            {applications.candidates.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.label}
              </option>
            ))}
          </Select>{' '}
          <Button disabled={busy || !application} onClick={() => void run(selectApplication)}>
            保存应用
          </Button>{' '}
          <Button
            disabled={busy}
            onClick={() => {
              setApplications(null);
              setApplication('');
            }}
          >
            取消
          </Button>
          {applications.candidates.length === 0 && <p>未检测到应用窗口，请启动应用后重新读取。</p>}
        </div>
      )}
      <p>音频分路完成前，新来源保持禁用；已有桌面声音保留。</p>
      {message && <p role="alert">{message}</p>}
      <details className="obs-audio-advanced">
        <summary>手动绑定与来源详情</summary>
        <h3>音频分路绑定</h3>
        <p>
          从 OBS 已有来源明确选择；TeamSpeak 多个客户端需自行辨认。绑定不会修改来源、监听或音轨。
        </p>
        <Button disabled={busy} onClick={() => void run(refresh)}>
          刷新 OBS 音频来源
        </Button>
        {status && (
          <>
            <p>
              当前 OBS：{status.endpoint}；场景集合：{status.collection}
            </p>
            {(Object.keys(labels) as ObsAudioRole[]).map((role) => (
              <div key={role}>
                <Select
                  label={labels[role]}
                  disabled={busy || Boolean(status.desktop || status.transition)}
                  value=""
                  onChange={(event) => void run(() => bind(role, event.target.value || null))}
                >
                  <option value="">选择来源或解除绑定</option>
                  {status.candidates.map((candidate, index) => (
                    <option key={candidate.selectionId} value={candidate.selectionId}>
                      {candidate.name} · {sourceTypes[candidate.kind] ?? '其他音频来源'}
                      {status.candidates.filter(
                        (item) => item.name === candidate.name && item.kind === candidate.kind,
                      ).length > 1
                        ? ` · ${status.candidates.slice(0, index + 1).filter((item) => item.name === candidate.name && item.kind === candidate.kind).length}`
                        : ''}
                    </option>
                  ))}
                </Select>{' '}
                <Button
                  disabled={
                    busy || Boolean(status.desktop || status.transition) || !status.bindings[role]
                  }
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
      </details>
    </div>
  );
}
