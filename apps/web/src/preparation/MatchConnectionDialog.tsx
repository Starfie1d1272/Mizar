import { useEffect, useRef, useState } from 'react';
import { parseObserverConnection, formatObserverConnection } from '@mizar/protocol/assist';
import { Button, Dialog, Field, StatusBanner } from '../ui';
import './match-connection.css';
import { command } from './client';
import { desktopInvoke } from '../workspace/client';
import { closeReviewWindow, isReviewWindow } from '../workspace/ReviewDialog';
import { flushObserverPreparation } from './observer-preparation';
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
  const [savedView, setSavedView] = useState<ConnectionPreparationView | null>(null);
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
  const [automatic, setAutomatic] = useState<boolean | null>(null);
  const [modeCheck, setModeCheck] = useState(0);
  const [confirmed, setConfirmed] = useState(false);
  const [saved, setSaved] = useState(false);
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
          setNextMap(Boolean(view.nextMapRequested));
          pending.current?.resolve(false);
          const next = { view, resolve };
          setSavedView(view);
          pending.current = next;
          setRequest(next);
          setError('');
          setAutomatic(null);
          setConfirmed(false);
          setSaved(false);
        }),
    );
    if (
      isReviewWindow() &&
      ['connection', 'next-connection'].includes(
        new URLSearchParams(window.location.search).get('kind') ?? '',
      )
    ) {
      void flushObserverPreparation(
        false,
        true,
        new URLSearchParams(window.location.search).get('kind') === 'next-connection',
      ).catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : '本图连接未读取，请重试。'),
      );
    }
    return () => {
      unregister();
      pending.current?.resolve(false);
      pending.current = null;
    };
  }, []);
  useEffect(() => {
    if (!request) return;
    let active = true;
    void (
      window.__TAURI_INTERNALS__
        ? desktopInvoke<{ useMulnx?: boolean }>('observer_command', { action: 'connection-mode' })
        : Promise.resolve({ useMulnx: false })
    )
      .then((result) => {
        if (active)
          setAutomatic(
            result.useMulnx === true && request.view.gameAutomation?.autoConnect === true,
          );
      })
      .catch(() => {
        if (active) setError('无法检查游戏连接方式，请重试。');
      });
    return () => {
      active = false;
    };
  }, [request, modeCheck]);
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
    void closeReviewWindow();
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
    if (operation.current || !request || pending.current !== request) return;
    operation.current = true;
    setBusy(true);
    setError('');
    try {
      if (!input.trim() && (nextMap || !savedView?.connection))
        throw new Error('请填写本图授权的观战连接。');
      if (input.trim()) {
        if (advanced && (!early.trim() || !program.trim())) throw new Error('请填写两路观战地址。');
      }
      const resultView = saved
        ? savedView!
        : ((await command('/operator/observer-assist', {
            action: 'map-connection',
            id: mapId.current,
            mode: 'connect',
            nextMap,
            expectedRevision: requireConnectionRevision(draftRevision.current),
            ...(input.trim()
              ? {
                  connection: parseObserverConnection(
                    input,
                    advanced ? program : undefined,
                    advanced ? early : undefined,
                  ),
                }
              : {}),
          })) as unknown as ConnectionPreparationView);
      setSaved(true);
      draftRevision.current = requireConnectionRevision(resultView.revision);
      if (pending.current !== request) return;
      setSavedView(resultView);
      // Host checks current game identity, production eligibility and configuration revision.
      if (window.__TAURI_INTERNALS__) {
        await desktopInvoke('observer_command', {
          action: 'start-configured',
          expectedRevision: requireConnectionRevision(draftRevision.current),
        });
        if (pending.current !== request) return;
      }
      if (pending.current !== request) return;
      setConfirmed(true);
      pending.current?.resolve(true);
      pending.current = null;
      setRequest(null);
      void closeReviewWindow();
    } catch (error) {
      if (pending.current !== request) return;
      setError(
        error instanceof Error
          ? error.message
          : typeof error === 'string' && error
            ? error
            : '请核对连接后重试。',
      );
    } finally {
      operation.current = false;
      setBusy(false);
    }
  };
  const endpoints = connection ?? (nextMap ? null : savedView?.connection);
  if (!request && error && isReviewWindow())
    return (
      <div role="alert">
        {error} <Button onClick={() => void closeReviewWindow()}>关闭窗口</Button>
      </div>
    );
  return (
    <Dialog
      open={Boolean(request)}
      title={nextMap ? '下一图 GoTV 连接' : '本图观战连接'}
      className="mizar-surface match-connection-dialog"
      onClose={close}
      canClose={() => !operation.current}
      showCloseButton={false}
      actions={
        <>
          <Button disabled={busy} onClick={close}>
            {confirmed ? '完成' : '取消'}
          </Button>
          <Button
            variant="primary"
            disabled={busy || confirmed || automatic === null}
            onClick={() => void confirm()}
          >
            {saved ? '重试准备' : '确认本图连接'}
          </Button>
        </>
      }
    >
      <Field
        label={nextMap ? '下一图 GoTV 连接' : '本图观战连接'}
        value={input}
        autoComplete="off"
        disabled={busy || saved || confirmed}
        onChange={(event) => {
          mapId.current = crypto.randomUUID();
          setInput(event.target.value);
          setCopied(false);
        }}
        placeholder="connect IP:27025;password 密码"
        message={
          nextMap ? '粘贴下一图的 GoTV 连接。' : '粘贴本图 GoTV 连接；留空可沿用本图已确认的连接。'
        }
      />
      {request && savedView?.connection && !request.view.nextMapRequested ? (
        <label>
          <input
            type="checkbox"
            checked={nextMap}
            disabled={busy || saved || confirmed || Boolean(request.view.nextMapRequested)}
            onChange={(event) => {
              mapId.current = crypto.randomUUID();
              setNextMap(event.target.checked);
            }}
          />
          这是下一张地图
        </label>
      ) : null}
      <details
        open={advanced}
        onToggle={(event) => {
          if (advanced !== event.currentTarget.open) mapId.current = crypto.randomUUID();
          setAdvanced(event.currentTarget.open);
        }}
      >
        <summary>高级设置</summary>
        <Field
          label="观察辅助 IPv4:端口"
          value={early}
          disabled={busy || saved || confirmed}
          onChange={(event) => {
            mapId.current = crypto.randomUUID();
            setEarly(event.target.value);
          }}
        />
        <Field
          label="游戏观战 IPv4:端口"
          value={program}
          disabled={busy || saved || confirmed}
          onChange={(event) => {
            mapId.current = crypto.randomUUID();
            setProgram(event.target.value);
          }}
        />
        <p>用于自定义端口或不同服务器；密码沿用上方连接中的值。</p>
      </details>
      {endpoints ? (
        <p>
          {connection ? '本图草稿' : '上次已确认'}
          <br />
          观察辅助：{endpoints.earlyEndpoint}
          <br />
          游戏观战：{endpoints.programEndpoint}
        </p>
      ) : null}
      {automatic === false ? (
        <p>
          复制下方节目源命令，在 CS2
          控制台粘贴并执行，再确认本图连接。确认后将按观察辅助设置准备早源，并等待游戏数据。
        </p>
      ) : automatic === true ? (
        <p>确认后将自动连接游戏节目源，按观察辅助设置准备早源，并等待游戏数据。</p>
      ) : null}
      {automatic === false &&
      (connection || (!nextMap && !input.trim() && request && savedView?.connection)) ? (
        <Button
          disabled={busy}
          onClick={() => {
            void (async () => {
              const text = connection
                ? formatObserverConnection(connection)
                : (
                    (await command('/operator/observer-assist', {
                      action: 'copy-connection',
                      expectedRevision: requireConnectionRevision(draftRevision.current),
                    })) as unknown as { command: string }
                  ).command;
              await navigator.clipboard.writeText(text);
            })()
              .then(() => setCopied(true))
              .catch(() => setError('复制未完成，请重试。'));
          }}
        >
          {copied ? '游戏连接命令已复制' : '复制游戏连接命令'}
        </Button>
      ) : null}
      {busy ? <p role="status">正在提交本图连接…</p> : null}
      {automatic === null && error ? (
        <Button
          onClick={() => {
            setError('');
            setModeCheck((value) => value + 1);
          }}
        >
          重新检查游戏
        </Button>
      ) : null}
      {error ? <StatusBanner tone="warning">{error}</StatusBanner> : null}
    </Dialog>
  );
}
