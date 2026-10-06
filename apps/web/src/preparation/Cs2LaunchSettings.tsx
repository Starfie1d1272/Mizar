import { useState } from 'react';
import { Button, Panel, StatusBanner } from '../ui';
import { desktopInvoke } from '../workspace/client';
import { checkObsBeforeLaunch, useLocalRead, type Production } from './client';

import { useCs2Status } from './cs2-status';
import { Cs2Recovery } from './Cs2Recovery';

export function Cs2LaunchSettings() {
  const desktop = Boolean(window.__TAURI_INTERNALS__);
  const production = useLocalRead<Production>(desktop ? '/local/v1/production' : null);
  const { status, phase, refresh } = useCs2Status();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function action(run: () => Promise<unknown>) {
    if (busy || phase) return;
    setBusy(true);
    setError('');
    try {
      await run();
      refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'CS2 操作未完成。');
    } finally {
      setBusy(false);
    }
  }
  return (
    <Panel>
      <h2>CS2 启动设置</h2>
      <p>窗口模式 · 分辨率适配工作台 · {status?.preserveQuality ? '保留原画质' : '最高画质'}</p>
      <p>首次先安装 GSI，并在 OBS 启用 WebSocket 服务器、连接并检查场景。</p>
      <p>本次启动使用国际服、开发者控制台与 OBS 游戏捕获兼容选项。</p>
      <details>
        <summary>启动项与工作台尺寸</summary>
        <code>-console -allow_third_party_software -worldwide</code>
        <p>
          仅传给本次 Steam 启动，Steam
          中保存的启动项保持原样。第三方软件选项可能影响信任系数。工作台会按屏幕可用空间调整游戏尺寸。
        </p>
      </details>
      <p>退出工作台或退出 Mizar 时关闭本次游戏并恢复原设置；隐藏工作区保留游戏。</p>
      {desktop ? (
        <div className="preparation-actions">
          <Button
            role="switch"
            aria-checked={status?.preserveQuality ?? false}
            disabled={!status || busy || Boolean(phase) || status.pending}
            onClick={() =>
              void action(() =>
                desktopInvoke('set_cs2_preferences', { preserveQuality: !status?.preserveQuality }),
              )
            }
          >
            保留原画质 · {status?.preserveQuality ? '开' : '关'}
          </Button>
          <Button
            disabled={!status || busy || Boolean(phase) || status.pending}
            onClick={() =>
              void action(async () => {
                if (await checkObsBeforeLaunch()) await desktopInvoke('start_managed_cs2');
              })
            }
          >
            {busy ? '处理中…' : '启动 CS2'}
          </Button>
        </div>
      ) : (
        <p>请在 Mizar 桌面应用中设置并启动 CS2。</p>
      )}
      <Cs2Recovery production={production} />
      {error ? <StatusBanner tone="danger">{error}</StatusBanner> : null}
    </Panel>
  );
}
