import type { OrchestrationView } from '@mizar/protocol/orchestration';
import { useLocalRead } from './client';
import { useEffect, useState } from 'react';
import { readObsConfigurationContext } from '../workspace/obs-client';
import { StatusBanner } from '../ui';

/** Show the Host's existing OBS configuration outcome. */
export function AutomaticPreparation() {
  const camera = useLocalRead<OrchestrationView>(
    window.__TAURI_INTERNALS__ ? '/local/v1/orchestration' : null,
  );
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
  return (
    <>
      {camera?.tool?.phase === 'preparing-bundle' && camera.tool.busy ? (
        <StatusBanner tone="info">正在准备内置 MulNX，完成后将继续启动工作台…</StatusBanner>
      ) : null}
      {configurationMessage ? (
        <StatusBanner tone="info">{configurationMessage}</StatusBanner>
      ) : null}
    </>
  );
}
