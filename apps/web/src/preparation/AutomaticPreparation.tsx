import { useEffect, useRef, useState } from 'react';
import { desktopInvoke } from '../workspace/client';
import { obsCommand, readObsConfigurationContext, useObsStatus } from '../workspace/obs-client';
import { StatusBanner } from '../ui';

/** Preparation owns bounded setup requests; Host and Companion own all configuration. */
export function AutomaticPreparation() {
  const obs = useObsStatus();
  const ensured = useRef<string | null>(null);
  const [gsiMessage, setGsiMessage] = useState('');
  const [obsMessage, setObsMessage] = useState('');
  const [configurationMessage, setConfigurationMessage] = useState('');
  useEffect(() => {
    if (!window.__TAURI_INTERNALS__) return;
    let active = true;
    void readObsConfigurationContext()
      .then(({ message }) => {
        if (active && message) setConfigurationMessage(message);
      })
      .catch(() => {
        if (active)
          setConfigurationMessage(
            'OBS 配置状态未能确认。如 OBS 仍在运行，请核对推流与录制后手动关闭。',
          );
      });
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    const finished = (event: Event) => {
      const message = (event as CustomEvent<unknown>).detail;
      if (typeof message === 'string') setConfigurationMessage(message);
    };
    window.addEventListener('mizar:obs-configuration-finished', finished);
    return () => window.removeEventListener('mizar:obs-configuration-finished', finished);
  }, []);
  useEffect(() => {
    if (!window.__TAURI_INTERNALS__) return;
    let active = true;
    const configured = () => setGsiMessage('');
    window.addEventListener('mizar:gsi-configured', configured);
    void desktopInvoke('ensure_gsi')
      .then(() => {
        if (active) window.dispatchEvent(new Event('mizar:gsi-configured'));
      })
      .catch(() => {
        if (active) setGsiMessage('GSI 自动配置未完成，请在游戏设置中检查安装位置或配置冲突。');
      });
    return () => {
      active = false;
      window.removeEventListener('mizar:gsi-configured', configured);
    };
  }, []);
  useEffect(() => {
    if (obs === null || obs.connection !== 'connected') {
      ensured.current = null;
      return;
    }
    const signature = JSON.stringify([obs.video, obs.findings]);
    if (ensured.current === signature || obs.streaming || obs.recording) return;
    ensured.current = signature;
    void obsCommand('ensure')
      .then(() => setObsMessage(''))
      .catch(() => setObsMessage('Mizar 场景自动配置未完成，请在 OBS 设置中查看诊断并修复。'));
  }, [obs]);
  return (
    <>
      {configurationMessage ? (
        <StatusBanner tone="info">{configurationMessage}</StatusBanner>
      ) : null}
      {gsiMessage ? <StatusBanner tone="info">{gsiMessage}</StatusBanner> : null}
      {obsMessage && (obs?.connection !== 'connected' || obs.findings.length > 0) ? (
        <StatusBanner tone="warning">{obsMessage}</StatusBanner>
      ) : null}
    </>
  );
}
