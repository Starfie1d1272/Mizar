import { useRef, useState } from 'react';
import type { MulnxToolView } from '@mizar/protocol/orchestration';
import { Button, Dialog, StatusBanner } from '../ui';
import {
  command,
  checkObsBeforeLaunch,
  productionAction,
  useLocalRead,
  type Production,
  type ExternalGameIdentity,
} from '../preparation/client';
import { desktopInvoke } from '../workspace/client';

export function MulnxToolControls({
  tool,
  allowStop = true,
  runtimeOnly = false,
  maintenanceOnly = false,
  preparedSession,
  onPreparedSessionChange,
}: {
  allowStop?: boolean;
  runtimeOnly?: boolean;
  maintenanceOnly?: boolean;
  preparedSession?: { preparedId: string; tag: string } | null;
  onPreparedSessionChange?: (value: { preparedId: string; tag: string } | null) => void;
  tool:
    | (Pick<MulnxToolView, 'installed' | 'latest' | 'busy'> &
        Partial<Omit<MulnxToolView, 'installed' | 'latest' | 'busy'>>)
    | undefined;
}) {
  const production = useLocalRead<Production>('/local/v1/production');
  const [refresh, setRefresh] = useState(0);
  const inventory = useLocalRead<{
    releases: { preparedId: string; tag: string | null; state: 'available' | 'damaged' }[];
  }>(runtimeOnly ? null : '/local/v1/mulnx-releases', 10000, refresh);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [failed, setFailed] = useState(false);
  const [localPrepared, setLocalPrepared] = useState<{ preparedId: string; tag: string } | null>(
    null,
  );
  const prepared = onPreparedSessionChange ? (preparedSession ?? null) : localPrepared;
  const setPrepared = onPreparedSessionChange ?? setLocalPrepared;
  const [confirmStop, setConfirmStop] = useState(false);
  const [stopSubmitted, setStopSubmitted] = useState(false);
  const running = useRef(false);
  if (!tool) return null;
  const releases = inventory?.releases ?? [];
  const available =
    prepared && !releases.some((item) => item.preparedId === prepared.preparedId)
      ? [...releases, { ...prepared, state: 'available' as const }]
      : releases;
  async function run(
    action: 'check' | 'open' | 'update' | 'prepare' | 'select' | 'stop',
    selection?: { preparedId: string; tag: string },
  ) {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setMessage('');
    setFailed(false);
    try {
      if (action === 'open') {
        if (!production || !(await checkObsBeforeLaunch(true))) return;
        const game = await desktopInvoke<ExternalGameIdentity>('launch_mulnx', { automatic: true });
        await productionAction('enter', production, false, undefined, game);
        setStopSubmitted(false);
        setMessage('已由 Mizar 启动 MulNX 游戏并进入工作台。');
      } else if (action === 'update') {
        await desktopInvoke('mulnx_control', { action: 'update' });
        setMessage('MulNX 版本准备已完成；确认支持自动启动后，从 Mizar 启动工作台。');
      } else if (action === 'prepare') {
        const result = await desktopInvoke<{ preparedId: string; tag: string }>('mulnx_control', {
          action: 'prepare',
        });
        setPrepared(result);
        setRefresh((value) => value + 1);
        setMessage(`已下载 ${result.tag}，可以在退出游戏后使用。`);
      } else if (action === 'select') {
        if (!selection) return;
        const result = await desktopInvoke<{ cameraReady?: boolean }>('mulnx_control', {
          action: 'select',
          preparedId: selection.preparedId,
        });
        setMessage(
          result?.cameraReady === false
            ? `已选择 ${selection.tag}。镜头资源已变化，请重新选择或使用方案。`
            : `已选择 ${selection.tag}，下次启动时使用。`,
        );
        setRefresh((value) => value + 1);
      } else if (action === 'stop') {
        const result = await desktopInvoke<{
          result?: string;
          execution?: string;
          cleanupPending?: boolean;
        } | null>('mulnx_control', {
          action: 'stop',
        });
        setStopSubmitted(true);
        setMessage(
          result?.execution === 'confirmed'
            ? 'MulNX 控制已停止，CS2 保持运行。'
            : '停止控制正在确认，请检查游戏状态。',
        );
        if (result?.cleanupPending)
          setMessage((value) => `${value} 工作台收尾尚未完成，请检查退出状态。`);
      } else await command('/operator/orchestration', { action: 'check-tool' }, undefined, 60_000);
    } catch (error) {
      setFailed(true);
      setMessage(
        /mulnx_metadata_http_(403|429)\b/.test(
          error instanceof Error ? error.message : String(error),
        )
          ? '无法检查 MulNX 更新：GitHub 拒绝了请求，可能已达到请求次数限制。请稍后重试。'
          : error instanceof Error
            ? error.message
            : action === 'stop'
              ? '停止操作未完成；请核对游戏与退出状态，结果不明确时不要重复发送。'
              : '操作失败，请重试。',
      );
    } finally {
      running.current = false;
      if (action === 'stop') setConfirmStop(false);
      setBusy(false);
    }
  }
  return (
    <div>
      {!runtimeOnly && !maintenanceOnly ? (
        <p>
          启动前请先退出完美世界竞技平台、其他竞技平台和游戏，Mizar 会调用 MulNX
          完成环境检查。仅用于离线 Demo 或已授权观战。
        </p>
      ) : null}
      {!runtimeOnly && !maintenanceOnly ? (
        <p>
          已选版本：{tool.installed ?? '首次启动时准备'}
          {tool.latest && tool.latest !== tool.installed ? ` · 可用版本 ${tool.latest}` : ''}
        </p>
      ) : null}
      {!runtimeOnly && !maintenanceOnly ? <p>运行版本：未确认</p> : null}
      {!runtimeOnly && tool.checkResult === 'error' ? (
        <p>未能确认最新版，请稍后重新检查。</p>
      ) : null}
      {!runtimeOnly && tool.checkedAt ? (
        <p>检查时间：{new Date(tool.checkedAt).toLocaleString()}</p>
      ) : null}
      {tool.phase === 'downloading' ? (
        <p>
          正在从 {tool.source} 下载：{tool.downloadedBytes ?? 0} / {tool.totalBytes ?? 0} 字节{' '}
          {tool.sourceMessage ? <span>{tool.sourceMessage} </span> : null}
          <Button
            onClick={() =>
              void command('/operator/orchestration', { action: 'cancel-tool-download' })
            }
          >
            取消下载
          </Button>
        </p>
      ) : null}
      {tool.phase === 'installing' ? <p>正在校验并准备版本…</p> : null}
      {!runtimeOnly ? (
        <Button disabled={busy || tool.busy} onClick={() => void run('check')}>
          检查更新
        </Button>
      ) : null}
      {maintenanceOnly && !tool.latest ? <span>检查更新后可查看最新版本。</span> : null}
      {!runtimeOnly && window.__TAURI_INTERNALS__ ? (
        <Button disabled={busy || tool.busy} onClick={() => void run('prepare')}>
          下载最新版本
        </Button>
      ) : null}
      {!runtimeOnly && !maintenanceOnly
        ? available.map((item) => (
            <div key={item.preparedId}>
              <p>已下载版本：{item.tag ?? '文件损坏'}</p>
              {window.__TAURI_INTERNALS__ && item.tag && item.state === 'available' ? (
                <Button
                  disabled={busy || tool.busy || production?.mode !== 'preparation'}
                  onClick={() =>
                    void run('select', { preparedId: item.preparedId, tag: item.tag! })
                  }
                >
                  使用已下载版本
                </Button>
              ) : null}
            </div>
          ))
        : null}
      {!runtimeOnly && window.__TAURI_INTERNALS__ && (!maintenanceOnly || tool.latest) ? (
        <Button disabled={busy || tool.busy} onClick={() => void run('update')}>
          {maintenanceOnly
            ? !tool.installed
              ? '安装'
              : tool.checkResult === 'available'
                ? '更新'
                : tool.installed === tool.latest
                  ? '重新安装'
                  : '更新'
            : '更新或重新准备 MulNX'}
        </Button>
      ) : null}
      {maintenanceOnly ? (
        <details className="resource-library__versions" open={prepared !== null}>
          <summary>版本</summary>
          <ul>
            <li>当前选择：{tool.installed ?? '尚未安装'}</li>
            {available.map((item) => (
              <li key={item.preparedId}>
                已下载：{item.tag ?? '文件损坏'}{' '}
                {window.__TAURI_INTERNALS__ && item.tag && item.state === 'available' ? (
                  <Button
                    disabled={busy || tool.busy || production?.mode !== 'preparation'}
                    onClick={() =>
                      void run('select', { preparedId: item.preparedId, tag: item.tag! })
                    }
                  >
                    使用此版本
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
          {!inventory ? <p>下载版本状态暂不可用。</p> : null}
        </details>
      ) : null}
      {!runtimeOnly && !maintenanceOnly && window.__TAURI_INTERNALS__ ? (
        <Button
          disabled={busy || tool.busy || !production?.canEnter || production.mode !== 'preparation'}
          onClick={() => void run('open')}
        >
          启动 MulNX 工作台
        </Button>
      ) : null}
      {!maintenanceOnly && window.__TAURI_INTERNALS__ && allowStop ? (
        <details>
          <summary>停止控制</summary>
          <Button
            disabled={busy || tool.busy || stopSubmitted}
            onClick={() => setConfirmStop(true)}
          >
            停止 MulNX 控制
          </Button>
        </details>
      ) : null}
      {!maintenanceOnly ? (
        <Dialog
          open={confirmStop}
          title="停止 MulNX 控制"
          onClose={() => setConfirmStop(false)}
          canClose={() => !busy}
        >
          <p>
            将结束本场制作、恢复游戏 HUD，并解除 MulNX 控制；CS2
            保持运行。停止结果需要在游戏内核对。
          </p>
          <Button disabled={busy} onClick={() => setConfirmStop(false)}>
            取消
          </Button>
          <Button
            variant="primary"
            disabled={busy}
            aria-busy={busy}
            onClick={() => void run('stop')}
          >
            {busy ? '正在请求停止…' : '结束制作并停止控制'}
          </Button>
        </Dialog>
      ) : null}
      {message ? <StatusBanner tone={failed ? 'danger' : 'info'}>{message}</StatusBanner> : null}
    </div>
  );
}
