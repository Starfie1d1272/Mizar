import type { PreparationStatus } from '@mizar/protocol/desktop-ipc';
import type { OrchestrationView } from '@mizar/protocol/orchestration';
import { useLocalRead } from './client';
import { useEffect, useState } from 'react';
import { desktopInvoke } from '../workspace/client';
import { readObsConfigurationContext } from '../workspace/obs-client';
import { StatusBanner } from '../ui';

/** Read the existing Host task, never retain a second completion message. */
export function usePreparationStatus() {
  const [status, setStatus] = useState<PreparationStatus | null>(null);
  useEffect(() => {
    if (!window.__TAURI_INTERNALS__) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const value = await desktopInvoke('preparation_status');
        if (active) setStatus(value);
      } catch {
        if (active) setStatus(null);
      }
      if (active) timer = setTimeout(() => void poll(), 1000);
    };
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, []);
  return status;
}
export function AutomaticPreparation() {
  // A view of the OBS configuration owner's latest receipt, independent of preparation.
  const [configuration, setConfiguration] = useState('');
  useEffect(() => {
    if (!window.__TAURI_INTERNALS__) return;
    let active = true;
    let revision = 0;
    const refresh = () => {
      const requested = ++revision;
      void readObsConfigurationContext().then(
        ({ message }) => {
          if (active && requested === revision) setConfiguration(message);
        },
        () => {
          if (active && requested === revision) setConfiguration('');
        },
      );
    };
    window.addEventListener('mizar:obs-configuration-finished', refresh);
    window.addEventListener('mizar:obs-configuration-changed', refresh);
    refresh();
    return () => {
      active = false;
      window.removeEventListener('mizar:obs-configuration-finished', refresh);
      window.removeEventListener('mizar:obs-configuration-changed', refresh);
    };
  }, []);
  const camera = useLocalRead<OrchestrationView>(
    window.__TAURI_INTERNALS__ ? '/local/v1/orchestration' : null,
  );
  return (
    <>
      {camera?.tool?.phase === 'preparing-bundle' && camera.tool.busy ? (
        <StatusBanner tone="info">正在准备游戏组件，可继续使用工作台。</StatusBanner>
      ) : null}
      {configuration ? <StatusBanner tone="warning">{configuration}</StatusBanner> : null}
    </>
  );
}
