import { useEffect, useRef, useState } from 'react';
import { parseObserverConnection, formatObserverConnection } from '@mizar/protocol/assist';
import { Button, Dialog, Field, StatusBanner } from '../ui';
import './match-connection.css';
import { command } from './client';
import { desktopInvoke } from '../workspace/client';
import {
  registerObserverPreparation,
  requireConnectionRevision,
  type ConnectionPreparationView,
  type EntryConfirmation,
} from './observer-preparation';

type Request = {
  view: ConnectionPreparationView;
  resolve: (accepted: EntryConfirmation) => void;
};
/** A draft only becomes the shared current connection on explicit confirmation. */
export function MatchConnectionDialog() {
  const [request, setRequest] = useState<Request | null>(null);
  const pending = useRef<Request | null>(null);
  const operation = useRef(false);
  const draftRevision = useRef<string | undefined>(undefined);
  const mapId = useRef('');
  const [input, setInput] = useState('');
  const [early, setEarly] = useState('');
  const [program, setProgram] = useState('');
  const [advanced, setAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [manual, setManual] = useState(false);
  const [mode, setMode] = useState<'connect' | 'seamless'>('connect');
  const [nextMap, setNextMap] = useState(false);
  useEffect(() => {
    const unregister = registerObserverPreparation(
      (view) =>
        new Promise<EntryConfirmation>((resolve) => {
          if (operation.current) {
            resolve(false);
            return;
          }
          if (draftRevision.current !== view.revision) {
            setInput('');
            setEarly('');
            setProgram('');
            setAdvanced(false);
            setCopied(false);
          }
          draftRevision.current = view.revision;
          mapId.current = crypto.randomUUID();
          setMode('connect');
          setNextMap(false);
          pending.current?.resolve(false);
          const next = { view, resolve };
          pending.current = next;
          setRequest(next);
          setError('');
          setConfirmed(false);
        }),
    );
    return () => {
      unregister();
      pending.current?.resolve(false);
      pending.current = null;
    };
  }, []);
  const close = () => {
    if (operation.current) return;
    if (confirmed) {
      setInput('');
      setEarly('');
      setProgram('');
      setAdvanced(false);
    }
    pending.current?.resolve(confirmed);
    pending.current = null;
    setRequest(null);
  };
  let connection: ReturnType<typeof parseObserverConnection> | null = null;
  try {
    if (mode === 'connect' && input.trim())
      connection = parseObserverConnection(
        input,
        advanced ? program : undefined,
        advanced ? early : undefined,
      );
  } catch {
    /* Report validation on confirmation. */
  }
  const confirm = async () => {
    if (operation.current || !request || pending.current !== request) return;
    operation.current = true;
    setBusy(true);
    setError('');
    try {
      if (!input.trim() && !request.view.connection) throw new Error('请填写本图授权的观战连接。');
      if (mode === 'connect' && input.trim()) {
        if (advanced && (!early.trim() || !program.trim()))
          throw new Error('请填写早源与节目源两个端点。');
      }
      const saved = (await command('/operator/observer-assist', {
        action: 'map-connection',
        id: mapId.current,
        mode,
        nextMap,
        expectedRevision: requireConnectionRevision(draftRevision.current),
        ...(mode === 'connect' && input.trim()
          ? {
              connection: parseObserverConnection(
                input,
                advanced ? program : undefined,
                advanced ? early : undefined,
              ),
            }
          : {}),
      })) as unknown as ConnectionPreparationView;
      draftRevision.current = requireConnectionRevision(saved.revision);
      if (pending.current !== request) return;
      // Host checks current game identity, production eligibility and configuration revision.
      if (window.__TAURI_INTERNALS__) {
        const result = await desktopInvoke<{ useMulnx?: boolean } | null>('observer_command', {
          action: 'start-configured',
          expectedRevision: requireConnectionRevision(draftRevision.current),
        });
        if (pending.current !== request) return;
        setManual(result?.useMulnx !== true);
      } else setManual(true);
      if (pending.current !== request) return;
      setConfirmed(true);
    } catch (error) {
      if (pending.current !== request) return;
      setError(error instanceof Error ? error.message : '请核对连接后重试。');
    } finally {
      operation.current = false;
      setBusy(false);
    }
  };
  const endpoints = connection ?? request?.view.connection;
  return (
    <Dialog
      open={Boolean(request)}
      title="本图观战连接"
      className="mizar-surface match-connection-dialog"
      onClose={close}
      canClose={() => !operation.current}
      showCloseButton={false}
    >
      <Field
        label="本图观战连接"
        value={input}
        autoComplete="off"
        disabled={busy || confirmed || mode === 'seamless'}
        onChange={(event) => {
          setInput(event.target.value);
          setCopied(false);
        }}
        placeholder="connect IP:27025;password 密码"
        message="粘贴本图授权连接；留空可沿用上次确认的地址和密码。重试早源请使用专用重试入口。"
      />
      {request?.view.connection ? (
        <label>
          <input
            type="checkbox"
            checked={nextMap || mode === 'seamless'}
            disabled={busy || confirmed || mode === 'seamless'}
            onChange={(event) => setNextMap(event.target.checked)}
          />
          这是下一张地图
        </label>
      ) : null}
      {request?.view.connection ? (
        <label>
          <input
            type="checkbox"
            checked={mode === 'seamless'}
            disabled={busy || confirmed}
            onChange={(event) => setMode(event.target.checked ? 'seamless' : 'connect')}
          />
          服务器已无缝换图，保持现有连接
        </label>
      ) : null}
      <details open={advanced} onToggle={(event) => setAdvanced(event.currentTarget.open)}>
        <summary>高级设置</summary>
        <Field
          label="早源 IPv4:端口"
          value={early}
          disabled={busy || confirmed || mode === 'seamless'}
          onChange={(event) => setEarly(event.target.value)}
        />
        <Field
          label="节目源 IPv4:端口"
          value={program}
          disabled={busy || confirmed || mode === 'seamless'}
          onChange={(event) => setProgram(event.target.value)}
        />
        <p>用于自定义端口或不同服务器；密码沿用上方连接中的值。</p>
      </details>
      {endpoints ? (
        <p>
          {connection ? '本图草稿' : '上次已确认'}
          <br />
          早源：{endpoints.earlyEndpoint}
          <br />
          游戏节目源：{endpoints.programEndpoint}
        </p>
      ) : null}
      <p>换图时保留工作台与游戏；服务器无缝换图时可保持现有连接。</p>
      <p>
        标准游戏请复制节目源命令并在控制台执行；复制不表示游戏已连接。使用第三方 HUD 时，请按 HUD
        指引手动隐藏游戏 HUD。
      </p>
      <p>
        MulNX 自动连接与隐藏 HUD
        沿用已有偏好，仅对当前已验证控制资格的游戏执行。已启用的私有观察辅助由 Host 独立连接早源。
      </p>
      <p>
        HUD
        自动隐藏需要启动前已配置的本机控制台记录；请从游戏与观战设置检查，工作台不会自动开启记录。
      </p>
      {connection ? (
        <Button
          disabled={busy}
          onClick={() => {
            void navigator.clipboard
              .writeText(formatObserverConnection(connection))
              .then(() => setCopied(true))
              .catch(() => setError('复制未完成，请重试。'));
          }}
        >
          {copied ? '节目源命令已复制' : '复制节目源连接命令'}
        </Button>
      ) : null}
      {busy ? <p role="status">正在提交本图连接…</p> : null}
      {confirmed ? (
        <StatusBanner tone="success">
          {mode === 'seamless'
            ? '已保留现有连接，请在游戏内核对新图；早源按辅助开关独立运行。'
            : manual
              ? '当前游戏没有已验证的 MulNX 控制资格，请在控制台手动执行节目源命令；早源按辅助开关独立准备。'
              : '本图连接操作已提交，请在游戏内核对节目源；命令入队不表示已经连接。'}
        </StatusBanner>
      ) : null}
      {error ? (
        <StatusBanner tone="warning">{error} 工作台和游戏保持打开，可重试本图连接。</StatusBanner>
      ) : null}
      <div className="preparation-actions">
        <Button disabled={busy} onClick={close}>
          {confirmed ? '完成' : '取消'}
        </Button>
        <Button variant="primary" disabled={busy || confirmed} onClick={() => void confirm()}>
          {error ? '重试本图连接' : '确认本图连接'}
        </Button>
      </div>
    </Dialog>
  );
}
