import { useEffect, useRef, useState } from 'react';
import { parseObserverConnection } from '@mizar/protocol/assist';
import { Button, Checkbox, Dialog, Field, StatusBanner } from '../ui';
import './match-connection.css';
import { command, useLocalRead } from './client';
import { desktopInvoke } from '../workspace/client';
import type { MulnxToolView } from '@mizar/protocol/orchestration';
import { MulnxToolControls } from '../orchestration/MulnxToolControls';
import {
  registerObserverPreparation,
  type ConnectionPreparationView,
  type EntryConfirmation,
} from './observer-preparation';

type Request = {
  view: ConnectionPreparationView;
  useMulnx: boolean;
  resolve: (accepted: EntryConfirmation) => void;
};
/** One per-entry confirmation feeds the game and the private observer. */
export function MatchConnectionDialog() {
  const [request, setRequest] = useState<Request | null>(null);
  const pending = useRef<Request | null>(null);
  const [input, setInput] = useState('');
  const [early, setEarly] = useState('');
  const [program, setProgram] = useState('');
  const [advanced, setAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [skipHud, setSkipHud] = useState(false);
  const [consoleRead, setConsoleRead] = useState(0);
  const [consoleStatus, setConsoleStatus] = useState<{
    enabled: boolean;
    generation: string | null;
    runtime?: { phase?: string };
  } | null>(null);
  const tool = useLocalRead<{ tool?: MulnxToolView }>(
    request?.useMulnx ? '/local/v1/orchestration' : null,
  )?.tool;
  useEffect(() => {
    if (!request?.useMulnx) return;
    let active = true;
    void desktopInvoke<NonNullable<typeof consoleStatus>>('cs2_console_status')
      .then((status) => {
        if (active) setConsoleStatus(status);
      })
      .catch(() => {
        if (active) {
          setConsoleStatus(null);
          setError('控制台记录状态读取失败，请重新读取。');
        }
      });
    return () => {
      active = false;
    };
  }, [request, consoleRead]);
  useEffect(() => {
    const unregister = registerObserverPreparation(
      (view, useMulnx) =>
        new Promise<EntryConfirmation>((resolve) => {
          pending.current?.resolve(false);
          const next = { view, useMulnx, resolve };
          pending.current = next;
          setRequest(next);
          setInput('');
          setSkipHud(false);
          setConsoleStatus(null);
          setEarly('');
          setProgram('');
          setAdvanced(false);
          setError('');
          setCopied(false);
        }),
    );
    return () => {
      unregister();
      pending.current?.resolve(false);
      pending.current = null;
    };
  }, []);
  const close = () => {
    pending.current?.resolve(false);
    pending.current = null;
    setRequest(null);
  };
  let connection: ReturnType<typeof parseObserverConnection> | null = null;
  try {
    if (input.trim())
      connection = parseObserverConnection(
        input,
        advanced ? program : undefined,
        advanced ? early : undefined,
      );
  } catch {
    /* Report validation on confirmation. */
  }
  const confirm = async () => {
    if (busy || !request || pending.current !== request) return;
    setBusy(true);
    setError('');
    try {
      if (
        (request.view.settings.enabled ||
          (request.useMulnx && request.view.gameAutomation?.autoConnect)) &&
        !input.trim() &&
        !request.view.connection
      )
        throw new Error('请填写本场授权的观战连接。');
      if (input.trim()) {
        if (advanced && (!early.trim() || !program.trim()))
          throw new Error('请填写早源与节目源两个端点。');
        await command('/operator/observer-assist', {
          action: 'connection',
          connection: parseObserverConnection(
            input,
            advanced ? program : undefined,
            advanced ? early : undefined,
          ),
        });
      }
      if (pending.current !== request) return;
      pending.current?.resolve(skipHud ? { skipGameHud: true } : true);
      pending.current = null;
      setRequest(null);
    } catch (error) {
      if (pending.current !== request) return;
      setError(error instanceof Error ? error.message : '请核对连接后重试。');
    } finally {
      setBusy(false);
    }
  };
  const endpoints = connection ?? request?.view.connection;
  const needsHud = request?.useMulnx && request.view.gameAutomation?.hideGameHud && !skipHud;
  const hudReady =
    request?.view.gameHudPrepared ||
    (consoleStatus?.enabled &&
      (!request?.view.gameRunning || consoleStatus.runtime?.phase === 'reading'));
  return (
    <Dialog
      open={Boolean(request)}
      title="确认本场观战连接"
      className="mizar-surface match-connection-dialog"
      onClose={close}
      canClose={() => !busy}
      showCloseButton={false}
    >
      {request?.useMulnx ? (
        <>
          {tool ? (
            <MulnxToolControls tool={tool} />
          ) : (
            <p role="status">MulNX 版本暂未确认，请在运镜设置中检查更新。</p>
          )}
          <p>自动启动需要支持启动协议 1 的 MulNX；旧版请先更新，再进入工作台。</p>
          {request.view.gameAutomation?.hideGameHud ? (
            <>
              <p>
                自动隐藏游戏 HUD 需要本机控制台记录，并用该设置启动游戏。游戏会写入
                console.log，可能包含聊天并持续增长。
              </p>
              {!hudReady && !skipHud ? (
                <StatusBanner tone="warning">
                  {request.view.gameRunning
                    ? '请确认游戏已启用控制台记录；必要时结束本次游戏后重新启动。'
                    : '进入前请启用本机控制台记录，或本次禁用自动隐藏。'}
                </StatusBanner>
              ) : null}
              {!consoleStatus ? (
                <Button
                  disabled={busy}
                  onClick={() => {
                    setError('');
                    setConsoleRead((value) => value + 1);
                  }}
                >
                  重新读取记录状态
                </Button>
              ) : null}
              {!consoleStatus?.enabled ? (
                <Button
                  disabled={busy || !consoleStatus || request.view.gameRunning}
                  onClick={() => {
                    if (!consoleStatus) return;
                    setBusy(true);
                    void desktopInvoke<NonNullable<typeof consoleStatus>>(
                      'set_cs2_console_capture',
                      { enabled: true, expectedGeneration: consoleStatus.generation },
                    )
                      .then((status) => {
                        if (pending.current === request) setConsoleStatus(status);
                      })
                      .catch((reason: unknown) => {
                        if (pending.current === request)
                          setError(
                            reason instanceof Error ? reason.message : '记录设置未保存，请重试。',
                          );
                      })
                      .finally(() => setBusy(false));
                  }}
                >
                  启用本机控制台记录
                </Button>
              ) : null}
              <Checkbox
                label="本次禁用自动隐藏游戏 HUD"
                checked={skipHud}
                disabled={busy || !request.view.capabilities?.skipGameHud}
                onChange={(event) => setSkipHud(event.target.checked)}
                message={
                  request.view.capabilities?.skipGameHud
                    ? '仅影响本次进入，保留已保存的自动操作设置。'
                    : '当前桌面组件尚未支持本次选项，请先更新或在游戏与观战设置关闭自动隐藏。'
                }
              />
            </>
          ) : null}
        </>
      ) : null}
      <Field
        label="本场观战连接"
        value={input}
        autoComplete="off"
        disabled={busy}
        onChange={(event) => {
          setInput(event.target.value);
          setCopied(false);
        }}
        placeholder="connect IP:27025;password 密码"
        message="粘贴 27025 早源或 27026 节目源均可，自动准备对应的两路连接。已有本场连接时可留空沿用。"
      />
      <details open={advanced} onToggle={(event) => setAdvanced(event.currentTarget.open)}>
        <summary>高级设置</summary>
        <Field
          label="早源 IPv4:端口"
          value={early}
          disabled={busy}
          onChange={(event) => setEarly(event.target.value)}
        />
        <Field
          label="节目源 IPv4:端口"
          value={program}
          disabled={busy}
          onChange={(event) => setProgram(event.target.value)}
        />
        <p>用于自定义端口或不同服务器；密码沿用上方连接中的值。</p>
      </details>
      {endpoints ? (
        <p>
          早源：{endpoints.earlyEndpoint}
          <br />
          游戏节目源：{endpoints.programEndpoint}
        </p>
      ) : null}
      <p>
        {request?.useMulnx && request.view.gameAutomation?.autoConnect
          ? '进入工作台后自动连接节目源。'
          : '游戏启动后，请在控制台执行节目源连接命令。'}
      </p>
      {connection && !(request?.useMulnx && request.view.gameAutomation?.autoConnect) ? (
        <Button
          disabled={busy}
          onClick={() => {
            void navigator.clipboard
              .writeText(`password "${connection.password}"; connect ${connection.programEndpoint}`)
              .then(() => setCopied(true))
              .catch(() => setError('复制未完成，请重试。'));
          }}
        >
          {copied ? '节目源命令已复制' : '复制节目源连接命令'}
        </Button>
      ) : null}
      {error ? <StatusBanner tone="warning">{error}</StatusBanner> : null}
      <div className="preparation-actions">
        <Button disabled={busy} onClick={close}>
          取消
        </Button>
        <Button
          variant="primary"
          disabled={busy || Boolean(needsHud && !hudReady)}
          onClick={() => void confirm()}
        >
          确认并进入工作台
        </Button>
      </div>
    </Dialog>
  );
}
