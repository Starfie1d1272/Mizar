import { useRef, useState } from 'react';
import type { MulnxToolView } from '@mizar/protocol/orchestration';
import { Button, Dialog, StatusBanner } from '../ui';
import { command, productionAction, useLocalRead, type Production } from '../preparation/client';
import { desktopInvoke } from '../workspace/client';

export function MulnxToolControls({
  tool,
  allowStop = true,
  runtimeOnly = false,
  maintenanceOnly = false,
}: {
  allowStop?: boolean;
  runtimeOnly?: boolean;
  maintenanceOnly?: boolean;
  tool:
    | (Pick<MulnxToolView, 'installed' | 'latest' | 'busy'> &
        Partial<Omit<MulnxToolView, 'installed' | 'latest' | 'busy'>>)
    | undefined;
}) {
  const production = useLocalRead<Production>('/local/v1/production');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [failed, setFailed] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);
  const running = useRef(false);
  if (!tool) return null;
  async function run(action: 'check' | 'update' | 'stop') {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setMessage('');
    setFailed(false);
    try {
      if (action === 'update') {
        await desktopInvoke('mulnx_control', { action: 'update' });
        setMessage('MulNX 版本准备已完成；确认支持自动启动后，从 Mizar 启动工作台。');
      } else if (action === 'stop') {
        if (!production) throw new Error('制作状态尚未读取，请稍后重试。');
        const result = await productionAction('finish', production);
        setMessage(
          result === 'unconfirmed'
            ? '本机收尾已完成，部分后台收尾仍待确认。'
            : '本次工作台已结束。',
        );
      } else await command('/operator/updates', { action: 'check' }, undefined, 60_000);
    } catch (error) {
      setFailed(true);
      setMessage(
        /mulnx_metadata_http_(403|429)\b/.test(
          error instanceof Error ? error.message : String(error),
        )
          ? '无法检查 MulNX 更新：GitHub 拒绝了请求，可能已达到请求次数限制。请稍后重试。'
          : error instanceof Error
            ? error.message === 'mulnx_metadata_stale'
              ? '发布元数据已过期，暂未确认最新版。请稍后重新检查。'
              : error.message
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
      {!runtimeOnly && tool.checkResult === 'error' ? (
        <p>暂未确认最新版；已准备的本机版本仍可使用，请稍后重新检查。</p>
      ) : null}
      {!runtimeOnly && tool.checkedAt ? (
        <p>本次检查时间：{new Date(tool.checkedAt).toLocaleString()}</p>
      ) : null}
      {!runtimeOnly && tool.confirmedAt ? (
        <p>版本确认时间：{new Date(tool.confirmedAt).toLocaleString()}</p>
      ) : null}
      {!runtimeOnly && tool.retryAt ? (
        <p>GitHub 可重试时间：{new Date(tool.retryAt).toLocaleString()}；仍可检查签名索引。</p>
      ) : null}
      {tool.phase === 'downloading' || tool.phase === 'verifying' ? (
        <p>
          {tool.phase === 'verifying'
            ? '正在校验'
            : tool.source
              ? `正在从 ${tool.source} 下载`
              : '正在选择下载来源…'}
          ：{tool.downloadedBytes ?? 0} / {tool.totalBytes ?? 0} 字节 {tool.sourceMessage}
          <Button
            onClick={() =>
              void command('/operator/orchestration', { action: 'cancel-tool-download' }).catch(
                () => {
                  setFailed(true);
                  setMessage('下载状态已变化，请刷新后查看。');
                },
              )
            }
          >
            取消下载
          </Button>
        </p>
      ) : null}
      {tool.phase === 'installing' ? <p>正在准备版本…</p> : null}
      {!runtimeOnly ? (
        <Button disabled={busy || tool.busy} onClick={() => void run('check')}>
          检查更新
        </Button>
      ) : null}
      {maintenanceOnly && !tool.latest ? <span>检查后可选择安装或更新。</span> : null}
      {!runtimeOnly && window.__TAURI_INTERNALS__ && (!maintenanceOnly || tool.latest) ? (
        <Button disabled={busy || tool.busy} onClick={() => void run('update')}>
          {maintenanceOnly
            ? !tool.installed
              ? '安装'
              : tool.installed === tool.latest
                ? '重新安装'
                : '更新'
            : '更新或重新准备 MulNX'}
        </Button>
      ) : null}
      {!maintenanceOnly && window.__TAURI_INTERNALS__ && allowStop ? (
        <details>
          <summary>结束工作台</summary>
          <Button disabled={busy || tool.busy} onClick={() => setConfirmStop(true)}>
            结束 MulNX 工作台
          </Button>
        </details>
      ) : null}
      {!maintenanceOnly ? (
        <Dialog
          open={confirmStop}
          title="结束 MulNX 工作台"
          onClose={() => setConfirmStop(false)}
          canClose={() => !busy}
        >
          <p>将结束本场制作，正常关闭本次 CS2，并恢复 Mizar 修改的游戏配置。</p>
          <Button disabled={busy} onClick={() => setConfirmStop(false)}>
            取消
          </Button>
          <Button
            variant="primary"
            disabled={busy}
            aria-busy={busy}
            onClick={() => void run('stop')}
          >
            {busy ? '正在请求停止…' : '结束制作并关闭游戏'}
          </Button>
        </Dialog>
      ) : null}
      {message ? <StatusBanner tone={failed ? 'danger' : 'info'}>{message}</StatusBanner> : null}
    </div>
  );
}
