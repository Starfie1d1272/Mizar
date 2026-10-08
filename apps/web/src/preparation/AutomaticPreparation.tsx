import { useEffect, useRef, useState } from 'react';
import { desktopInvoke } from '../workspace/client';
import { obsCommand, useObsStatus } from '../workspace/obs-client';
import { StatusBanner } from '../ui';

/** Preparation owns bounded setup requests; Host and Companion own all configuration. */
export function AutomaticPreparation() {
  const obs = useObsStatus();
  const ensured = useRef(false);
  const [gsiMessage, setGsiMessage] = useState('');
  const [obsMessage, setObsMessage] = useState('');
  useEffect(() => {
    if (!window.__TAURI_INTERNALS__) return;
    let active = true;
    void desktopInvoke('ensure_gsi')
      .then(() => {
        if (active) window.dispatchEvent(new Event('mizar:gsi-configured'));
      })
      .catch(() => {
        if (active) setGsiMessage('GSI 自动配置未完成，请在游戏设置中检查安装位置或配置冲突。');
      });
    void obsCommand('open').catch((error: unknown) => {
      if (active) setObsMessage(error instanceof Error ? error.message : '请检查 OBS 安装位置。');
    });
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    if (obs === null) return;
    if (obs.connection !== 'connected') {
      ensured.current = false;
      return;
    }
    if (ensured.current || obs.streaming || obs.recording) return;
    ensured.current = true;
    void obsCommand('ensure')
      .then(() => setObsMessage(''))
      .catch(() => setObsMessage('Mizar 场景自动配置未完成，请在 OBS 设置中查看诊断并修复。'));
  }, [obs]);
  return (
    <>
      {gsiMessage ? <StatusBanner tone="info">{gsiMessage}</StatusBanner> : null}
      {obsMessage ? <StatusBanner tone="warning">{obsMessage}</StatusBanner> : null}
    </>
  );
}
