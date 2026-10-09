import { useEffect, useRef, useState } from 'react';
import { desktopInvoke } from '../workspace/client';
import { obsCommand, useObsStatus } from '../workspace/obs-client';
import { StatusBanner } from '../ui';

/** Preparation owns bounded setup requests; Host and Companion own all configuration. */
export function AutomaticPreparation() {
  const obs = useObsStatus();
  const ensured = useRef(false);
  const [gsiMessage, setGsiMessage] = useState('正在自动检查 GSI。');
  const [obsMessage, setObsMessage] = useState('');
  const [obsLaunchMessage, setObsLaunchMessage] = useState('');
  useEffect(() => {
    if (!window.__TAURI_INTERNALS__) return;
    let active = true;
    const configured = () => setGsiMessage('GSI 自动准备已完成。');
    window.addEventListener('mizar:gsi-configured', configured);
    void desktopInvoke<{ pending?: boolean; busy?: boolean }>('cs2_config_status')
      .then((status) => {
        if (status.pending || status.busy) throw new Error('游戏配置处于运行或恢复阶段。');
        return desktopInvoke('ensure_gsi');
      })
      .then(() => {
        if (active) window.dispatchEvent(new Event('mizar:gsi-configured'));
      })
      .catch(() => {
        if (active)
          setGsiMessage('GSI 自动准备待处理，请在游戏设置中检查安装位置、配置冲突或恢复记录。');
      });
    void obsCommand('open')
      .then((result) => {
        if (!active) return;
        const running = (result as { alreadyRunning?: boolean } | null)?.alreadyRunning;
        setObsLaunchMessage(
          running
            ? '已检测到运行中的 OBS，等待 WebSocket 连接。'
            : 'OBS 已安装，已发出启动请求，等待 WebSocket 连接。',
        );
      })
      .catch((error: unknown) => {
        if (active) setObsMessage(error instanceof Error ? error.message : '请检查 OBS 安装位置。');
      });
    return () => {
      active = false;
      window.removeEventListener('mizar:gsi-configured', configured);
    };
  }, []);
  useEffect(() => {
    if (!window.__TAURI_INTERNALS__ || obs === null || obs.connection !== 'connected') {
      ensured.current = false;
      return;
    }
    if (ensured.current || obs.streaming || obs.recording) return;
    ensured.current = true;
    void obsCommand('ensure')
      .then(() => setObsMessage(''))
      .catch(() => setObsMessage('Mizar 场景自动配置未完成，请在 OBS 设置中查看诊断并修复。'));
  }, [obs]);
  if (!window.__TAURI_INTERNALS__) return null;
  return (
    <>
      {gsiMessage ? (
        <StatusBanner tone="info">
          {gsiMessage} <a href="/settings?tab=gsi">重查 GSI / 配置恢复</a>
        </StatusBanner>
      ) : null}
      {obsLaunchMessage && obs?.connection !== 'connected' ? (
        <StatusBanner tone="info">
          {obsLaunchMessage} 请在 OBS「工具 → WebSocket
          服务器设置」中启用服务器并在设置中填写有效密码。
          <a href="/settings?tab=obs">重查 OBS 连接</a>
        </StatusBanner>
      ) : null}
      {obsMessage && (obs?.connection !== 'connected' || obs.findings.length > 0) ? (
        <StatusBanner tone="warning">
          {obsMessage} <a href="/settings?tab=obs">查看 OBS 诊断 / 重查</a>
        </StatusBanner>
      ) : null}
    </>
  );
}
