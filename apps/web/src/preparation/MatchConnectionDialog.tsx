import { useEffect, useRef, useState } from 'react';
import { parseObserverConnection } from '@mizar/protocol/assist';
import { Button, Dialog, Field, StatusBanner } from '../ui';
import './match-connection.css';
import { command } from './client';
import {
  registerObserverPreparation,
  type ConnectionPreparationView,
} from './observer-preparation';

type Request = {
  view: ConnectionPreparationView;
  useMulnx: boolean;
  resolve: (accepted: boolean) => void;
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
  useEffect(() => {
    const unregister = registerObserverPreparation(
      (view, useMulnx) =>
        new Promise<boolean>((resolve) => {
          pending.current?.resolve(false);
          const next = { view, useMulnx, resolve };
          pending.current = next;
          setRequest(next);
          setInput('');
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
    setBusy(true);
    setError('');
    try {
      if (!input.trim() && !request?.view.connection) throw new Error('请填写本场授权的观战连接。');
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
      pending.current?.resolve(true);
      pending.current = null;
      setRequest(null);
    } catch (error) {
      setError(error instanceof Error ? error.message : '请核对连接后重试。');
    } finally {
      setBusy(false);
    }
  };
  const endpoints = connection ?? request?.view.connection;
  return (
    <Dialog
      open={Boolean(request)}
      title="确认本场观战连接"
      className="mizar-surface match-connection-dialog"
      onClose={close}
      canClose={() => !busy}
      showCloseButton={false}
    >
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
        <Button variant="primary" disabled={busy} onClick={() => void confirm()}>
          确认并进入工作台
        </Button>
      </div>
    </Dialog>
  );
}
