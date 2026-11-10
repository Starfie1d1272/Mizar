import { useEffect, useRef, useState } from 'react';
import type { ObsAudioRoutingStatus } from '@mizar/protocol/obs';
import { Button, Select } from '../ui';

import { ObsAudioMeter } from './ObsAudioMeter';
import { ObsAudioDevices } from './ObsAudioDevices';

export function ObsAudioRouting({ active = true }: { active?: boolean }) {
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
  const [commentaryPreparing, setCommentaryPreparing] = useState(false);
  const [applications, setApplications] = useState<{
    revision: string;
    candidates: { id: string; label: string }[];
  } | null>(null);
  const [application, setApplication] = useState('');
  // This is only a suggested target; no OBS configuration changes until confirmed.
  const [targetMode, setTargetMode] = useState<'desktop' | 'independent'>('desktop');
  const targetInitialized = useRef(false);
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
  useEffect(() => {
    if (!status?.waitingIndependent && !status?.transition && !commentaryPreparing) return;
    let active = true;
    const timer = setInterval(() => {
      void refresh()
        .then((current) => {
          if (active && commentaryPreparing && commentaryReady(current)) {
            setCommentaryPreparing(false);
            setMessage('解说来源已绑定。');
          }
        })
        .catch(() => undefined);
    }, 2500);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [status?.waitingIndependent, status?.transition, commentaryPreparing]);
  async function cancelWaitBeforeChoice() {
    if (status?.waitingIndependent) await switchMode('cancel');
  }
  async function setMode(mode: 'autoTeamspeak' | 'disabled') {
    if (!commentary) return;
    await cancelWaitBeforeChoice();
    const response = await fetch('/operator/obs/remote-commentary', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode, revision: commentary.revision }),
    });
    if (!response.ok) {
      await refreshCommentary().catch(() => undefined);
      const result = (await response.json()) as { message?: string };
      throw new Error(result.message ?? '设置未确认，请核对后重试。');
    }
    await refreshCommentary().catch(() => {
      throw new Error('选择已保存，但解说设置刷新失败；请重新读取后核对。');
    });
    setApplications(null);
    setApplication('');
    const current = await refresh().catch(() => {
      throw new Error('选择已保存，但音频状态刷新失败；请重新读取 OBS 音频来源。');
    });
    if (current.desktop) {
      setCommentaryPreparing(false);
      setMessage('分离采集的选择已保存。需要独立分路时，请在上方选择并切回。');
    } else if (!Object.values(current.bindings).some(Boolean)) {
      setCommentaryPreparing(false);
      setMessage('分离采集的选择已保存。请先准备 OBS 场景，再在上方准备独立分路。');
    } else if (mode === 'autoTeamspeak') await prepareCommentary();
    else setCommentaryPreparing(false);
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
    await cancelWaitBeforeChoice();
    const response = await fetch('/operator/obs/remote-commentary/application', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ revision: applications.revision, selectionId: application }),
    });
    if (!response.ok) {
      const result = (await response.json()) as { message?: string };
      throw new Error(result.message ?? '应用列表已变化，请重新读取并选择。');
    }
    setApplications(null);
    setApplication('');
    await refreshCommentary().catch(() => {
      throw new Error('应用已保存，但解说设置刷新失败；请重新读取后核对。');
    });
    const current = await refresh().catch(() => {
      throw new Error('应用已保存，但音频状态刷新失败；请重新读取 OBS 音频来源。');
    });
    if (current.desktop) setMessage('分离采集的应用已保存。需要独立分路时，请在上方选择并切回。');
    else if (!Object.values(current.bindings).some(Boolean))
      setMessage('分离采集的应用已保存。请先准备 OBS 场景，再在上方准备独立分路。');
    else await prepareCommentary();
  }
  function commentaryReady(current: ObsAudioRoutingStatus) {
    return (
      !current.desktop &&
      !current.transition &&
      !current.waitingIndependent &&
      !current.independentCommentaryDisabled &&
      Boolean(current.bindings.remoteCommentary?.valid)
    );
  }
  async function prepareCommentary() {
    const wasReenabling = Boolean(
      status && !status.desktop && status.independentCommentaryDisabled,
    );
    const current = await refresh();
    if (wasReenabling || (!current.desktop && current.independentCommentaryDisabled)) {
      if (commentaryReady(current)) setMessage('解说来源已绑定。');
      else {
        setCommentaryPreparing(true);
        setMessage('请在来源就绪后点击“再次尝试切回独立分路”。');
      }
      return;
    }
    const configured = await fetch('/operator/obs/commentary-prepare', { method: 'POST' });
    if (!configured.ok) {
      const result = (await configured.json()) as { message?: string };
      throw new Error(result.message ?? '解说音频尚未准备，请检查 OBS。');
    }
    const result = (await configured.json()) as { findings: { code: string; message: string }[] };
    await refresh();
    const pending =
      result.findings.find((finding) => finding.code === 'commentary_pending') ??
      result.findings[0];
    setMessage(pending?.message ?? '解说音频配置已准备，请让解说说话并录制试听。');
  }
  async function refresh() {
    const response = await fetch('/local/v1/obs/audio-routing', { cache: 'no-store' });
    if (!response.ok) throw new Error('无法读取 OBS 音频来源，请检查连接。');
    const current = (await response.json()) as ObsAudioRoutingStatus;
    if (!targetInitialized.current) {
      targetInitialized.current = true;
      setTargetMode(current.desktop ? 'independent' : 'desktop');
    }
    setStatus(current);
    return current;
  }
  async function run(action: () => Promise<unknown>) {
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
  async function switchMode(mode: 'desktop' | 'independent' | 'cancel' | 'recover') {
    if (!status) return;
    const cancelling = mode === 'cancel';
    const response = await fetch('/operator/obs/audio-mode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        revision: status.revision,
        mode,
      }),
    });
    if (!response.ok) {
      const result = (await response.json()) as { error?: string; message?: string };
      await refresh().catch(() => undefined);
      throw new Error(
        result.message ??
          '切换结果未确认，请立即在 OBS 核对当前音源与直播电平；如无声请手动恢复可用来源。',
      );
    }
    const result = (await response.json()) as { monitorPending?: boolean; waiting?: boolean };
    if (cancelling) setCommentaryPreparing(false);
    const current = await refresh();
    if (!cancelling && !result.waiting) setTargetMode(current.desktop ? 'independent' : 'desktop');
    setMessage(
      mode === 'recover'
        ? '已核对并恢复音频状态，请录制试听。'
        : cancelling
          ? '已取消等待。'
          : result.waiting
            ? '解说来源尚未就绪，桌面混音仍可用。准备好后请再次点击切回。'
            : result.monitorPending
              ? '已切换桌面混音；音乐仍播出，本机监听暂缓。'
              : mode === 'desktop'
                ? '已切换桌面混音。请录制试听。'
                : '已切换独立分路。请录制试听。',
    );
  }
  return (
    <div>
      <h3>音频模式</h3>
      <p>
        桌面混音采集所选播放设备上的声音，无法分别调节游戏与解说；麦克风仍单独控制。 OBS
        中的音乐若同时直出并监听到该设备，可能重复收音，请核对监听并录制试听。
        请在采集设备中核对实际播放设备与麦克风。
      </p>
      <details>
        <summary>核对播放设备（包括 Sonar Chat / Gaming）</summary>
        <ol>
          <li>
            停止直播与录像后，在 TeamSpeak 的播放设置和 Windows 音量混合器中核对实际输出设备。 Sonar
            Chat 与 Gaming 是不同设备；只采集其中一路不会自动包含另一路。
          </li>
          <li>
            在下方读取设备，核对「桌面声音」所选设备，不要仅凭“默认”判断。
            若游戏与解说输出到不同设备，请保留独立分路，或先在播放端明确混合到同一设备。
          </li>
          <li>
            使用下方「采集设备」设置固定的桌面声音和麦克风，不要另建或绑定任意 OBS 来源。 Mizar
            会维护专用集合中的来源；请勿额外启用全局桌面音频。
          </li>
          <li>
            切换后让远端解说说话，并分别播放游戏和音乐，录制试听确认三者齐全且没有重复声音。
            核对失败时保留原有可用配置，不要在直播中试切模式。
          </li>
        </ol>
      </details>
      <Button disabled={busy} onClick={() => void run(refresh)}>
        读取 OBS 音频来源
      </Button>
      {status && (
        <>
          <p>
            当前模式：
            {status.transition
              ? '上次切换待核对'
              : status.waitingIndependent
                ? status.desktop
                  ? '桌面混音，等待解说来源（就绪后需手动切回）'
                  : '独立分路，等待解说来源（就绪后需手动启用）'
                : status.desktop
                  ? '桌面混音'
                  : !status.bindings.game &&
                      !status.bindings.remoteCommentary &&
                      !status.bindings.microphone
                    ? '未确认，请检查 OBS'
                    : '独立分路'}
          </p>
          {status.desktop && (
            <p>
              当前 OBS 桌面来源：
              {status.candidates.find((candidate) => candidate.uuid === status.desktop?.inputUuid)
                ?.name ?? '未找到，请检查 OBS'}
              。停止输出后，可在下方更换采集设备。
            </p>
          )}
          {status.transition ? (
            <div>
              <p role="alert">
                上次切换结果未确认。请核对当前音源和电平，再恢复音频状态；恢复可能改变当前可听路径。
              </p>
              <Button disabled={busy} onClick={() => void run(() => switchMode('recover'))}>
                恢复音频状态
              </Button>
            </div>
          ) : status.waitingIndependent ? (
            <>
              <Button disabled={busy} onClick={() => void run(() => switchMode('cancel'))}>
                取消等待
              </Button>{' '}
              <Button disabled={busy} onClick={() => void run(() => switchMode('independent'))}>
                再次尝试切回独立分路
              </Button>
            </>
          ) : (
            <>
              <Select
                label="切换目标"
                value={targetMode}
                disabled={busy}
                onChange={(event) => {
                  setTargetMode(event.target.value as 'desktop' | 'independent');
                }}
              >
                <option value="desktop">桌面混音（新设置推荐）</option>
                <option value="independent">独立分路</option>
              </Select>
              <p>
                选择目标本身不会切换模式。场景准备可能先添加默认桌面音频和麦克风，请在 OBS
                核对设备。
              </p>
              <Button
                disabled={
                  busy ||
                  (targetMode === 'desktop' && Boolean(status.desktop)) ||
                  (targetMode === 'independent' &&
                    !status.desktop &&
                    (Boolean(
                      status.bindings.game ||
                      status.bindings.remoteCommentary ||
                      status.bindings.microphone,
                    ) ||
                      !commentary ||
                      commentary.preference.mode === 'disabled'))
                }
                onClick={() =>
                  void run(() =>
                    targetMode === 'independent' && !status.desktop
                      ? prepareCommentary()
                      : switchMode(targetMode),
                  )
                }
              >
                {targetMode === 'desktop'
                  ? '切换桌面混音'
                  : status.desktop
                    ? '切回独立分路'
                    : '准备独立分路'}
              </Button>
              {targetMode === 'independent' && !status.desktop && (
                <p>请先启动解说应用，再确认准备独立分路；实际声音仍需录制试听。</p>
              )}
            </>
          )}
        </>
      )}
      <h3>远端解说音频</h3>
      <p className="obs-audio-commentary-current">
        分离采集选择：
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
          Boolean(status?.transition || (status?.desktop && status.bindings.remoteCommentary)) ||
          !commentary
        }
        onClick={() => void run(() => setMode('autoTeamspeak'))}
      >
        自动识别 TeamSpeak
      </Button>{' '}
      <Button
        disabled={
          busy ||
          !status?.desktop ||
          Boolean(status.transition) ||
          !commentary ||
          commentary.preference.mode === 'disabled'
        }
        onClick={() => void run(() => setMode('disabled'))}
      >
        切回时停用分离解说
      </Button>{' '}
      <Button
        disabled={
          busy ||
          Boolean(status?.transition || (status?.desktop && status.bindings.remoteCommentary))
        }
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
      {!status?.desktop &&
        !status?.transition &&
        !status?.waitingIndependent &&
        commentary?.preference.mode !== 'disabled' && (
          <Button disabled={busy} onClick={() => void run(prepareCommentary)}>
            重新准备解说音频
          </Button>
        )}
      <p>
        桌面混音时可以停用分离解说；尚未绑定解说来源时也可预先选择应用。
        已有绑定的应用不能在桌面模式下更换；请先恢复原应用并切回独立分路，再更换。选择停用后切回分离采集将不包含远端解说。
        停用分离解说不会移除桌面混音中的语音；如需停止它，请在语音应用中静音。
        当前是独立分路时，可在上方混音器静音远端解说。 完成切换后请让其他解说说话并录制试听，同时在
        OBS 核对直播音轨和实际播放设备。 来源已绑定不代表语音已被采集。
      </p>
      {commentaryPreparing && !message && (
        <p role="status">
          {status?.waitingIndependent ? '等待解说应用接入。' : '正在准备解说音频。'}
        </p>
      )}
      {message && <p role="alert">{message}</p>}
      {active && !busy && !status?.transition && (
        <ObsAudioMeter key={`meter:${status?.revision ?? 'unavailable'}`} />
      )}
      <ObsAudioDevices
        key={`devices:${status?.revision ?? 'unavailable'}`}
        disabled={busy || Boolean(status?.transition || status?.waitingIndependent)}
      />
      <details className="obs-audio-advanced">
        <summary>来源详情</summary>
        <p>
          游戏声音、其他解说和麦克风使用专用集合内的固定来源。解说应用在上方选择，游戏目标沿用 Mizar
          的游戏准备。
        </p>
        {status && (
          <>
            <p>
              当前 OBS：{status.endpoint}；场景集合：{status.collection}
            </p>
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
