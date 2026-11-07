import { ControlTask } from '../debug/control-task';
import { useRef, useState } from 'react';
import { parseObserverConnection } from '@mizar/protocol/assist';
import { Button, Field, Select, StatusBanner } from '../ui';
import { command, useLocalRead } from './client';
import { desktopInvoke } from '../workspace/client';
import {
  requireConnectionRevision,
  type ObserverRuntimeView,
  type ConnectionPreparationView,
} from './observer-preparation';
import './match-connection.css';

/** One persistent tool owns only its draft. The observer owns connection intent and revision. */
export function MatchConnectionDialog() {
  const view = useLocalRead<ConnectionPreparationView>('/local/v1/observer-assist');
  const runtime = useLocalRead<ObserverRuntimeView>('/local/v1/observer');
  const [stopping, setStopping] = useState(false);
  const [input, setInput] = useState('');
  const [earlyEndpoint, setEarlyEndpoint] = useState('');
  const [programEndpoint, setProgramEndpoint] = useState('');
  const [nextMap, setNextMap] = useState(false);
  const [registerCurrent, setRegisterCurrent] = useState(false);
  const [revision, setRevision] = useState<string>();
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [manualCommand, setManualCommand] = useState('');
  const [copied, setCopied] = useState(false);
  const operation = useRef(false);
  const intent = useRef(crypto.randomUUID());
  const stale = Boolean(view && revision && view.revision !== revision);
  const submit = async () => {
    if (operation.current) return;
    operation.current = true;
    setBusy(true);
    setError('');
    const task = new ControlTask('observer_map_connection', 'user', {
      intentId: intent.current,
      mode: registerCurrent ? 'register-current' : 'connect',
      nextMap,
      expectedRevision: revision ?? view?.revision,
      retry: saved,
    });
    try {
      let currentRevision = requireConnectionRevision(revision ?? view?.revision);
      if (!saved) {
        if (!input.trim()) throw new Error('请填写赛事方提供的 GoTV 命令。');
        const result = (await command(
          '/operator/observer-assist',
          {
            action: 'map-connection',
            id: intent.current,
            mode: registerCurrent ? 'register-current' : 'connect',
            nextMap,
            expectedRevision: currentRevision,
            connection: parseObserverConnection(
              input,
              programEndpoint || undefined,
              earlyEndpoint || undefined,
            ),
          },
          task,
        )) as unknown as ConnectionPreparationView;
        currentRevision = requireConnectionRevision(result.revision);
        setRevision(currentRevision);
        setSaved(true);
        task.event('registered', { revision: currentRevision });
      }
      const mode = window.__TAURI_INTERNALS__
        ? await desktopInvoke<{ useMulnx?: boolean }>('observer_command', {
            action: 'connection-mode',
          })
        : { useMulnx: false };
      if (!registerCurrent && !(mode.useMulnx && view?.gameAutomation?.autoConnect)) {
        const result = (await command('/operator/observer-assist', {
          action: 'copy-connection',
          expectedRevision: currentRevision,
        })) as unknown as { command: string };
        setManualCommand(result.command);
      }
      if (window.__TAURI_INTERNALS__)
        await desktopInvoke(
          'observer_command',
          {
            action: 'start-configured',
            expectedRevision: currentRevision,
          },
          task,
        );
      task.finish('unconfirmed', {
        registration: 'confirmed',
        game: 'awaiting_owner_evidence',
        hints: 'awaiting_owner_evidence',
      });
    } catch (reason) {
      task.fail(reason);
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      operation.current = false;
      setBusy(false);
    }
  };
  return (
    <main className="mizar-surface match-connection-dialog">
      <h1>GoTV 连接</h1>
      <Select
        label="连接目标"
        value={nextMap ? 'next' : 'current'}
        disabled={busy || saved}
        onChange={(event) => {
          if (!revision) setRevision(view?.revision);
          setNextMap(event.target.value === 'next');
          setRegisterCurrent(false);
          intent.current = crypto.randomUUID();
        }}
      >
        <option value="current">本图</option>
        <option value="next">下一图</option>
      </Select>
      <Field
        label="GoTV 命令"
        value={input}
        autoComplete="off"
        disabled={busy || saved}
        placeholder="connect IP:27025; password 密码"
        message="如果赛事提供 27025 和 27026 两个 GoTV 地址，请填写 27025 结尾的命令；其他端口请展开连接兼容说明。"
        onChange={(event) => {
          if (!revision) setRevision(view?.revision);
          setInput(event.target.value);
          intent.current = crypto.randomUUID();
        }}
      />
      <details>
        <summary>连接兼容说明</summary>
        <Field
          label="自定义提前提示端点（可选）"
          value={earlyEndpoint}
          disabled={busy || saved}
          onChange={(event) => {
            if (!revision) setRevision(view?.revision);
            setEarlyEndpoint(event.target.value);
            intent.current = crypto.randomUUID();
          }}
        />
        <Field
          label="自定义游戏端点（可选）"
          value={programEndpoint}
          disabled={busy || saved}
          onChange={(event) => {
            if (!revision) setRevision(view?.revision);
            setProgramEndpoint(event.target.value);
            intent.current = crypto.randomUUID();
          }}
        />
        <p>
          支持的双端口赛事使用 27025 接收提前提示、27026
          连接游戏。其他端口不会被自动改写，请核对赛事方说明。
        </p>
      </details>
      {!nextMap ? (
        <label>
          <input
            type="checkbox"
            checked={registerCurrent}
            disabled={busy || saved}
            onChange={(event) => {
              setRegisterCurrent(event.target.checked);
              intent.current = crypto.randomUUID();
            }}
          />
          我已在 CS2 观战，只登记当前连接并启用提前提示
        </label>
      ) : null}
      {stale ? (
        <StatusBanner tone="warning">
          比赛或连接设置已变化。请核对草稿目标后重新确认。
          <Button
            disabled={busy}
            onClick={() => {
              setRevision(view!.revision);
              setNextMap(false);
              setSaved(false);
              setManualCommand('');
              intent.current = crypto.randomUUID();
            }}
          >
            将草稿用于本图
          </Button>
        </StatusBanner>
      ) : null}
      {saved ? <p role="status">连接已登记，游戏和提前提示的接收结果分别在工作台确认。</p> : null}
      {manualCommand ? (
        <section>
          <p>在 CS2 控制台执行以下命令：</p>
          <p>{manualCommand}</p>
          <Button
            onClick={() =>
              void navigator.clipboard
                .writeText(manualCommand)
                .then(async () => {
                  setCopied(true);
                  if (window.__TAURI_INTERNALS__) {
                    const focused = await desktopInvoke<boolean>('restore_cs2_focus');
                    if (!focused) setError('已复制，请用 Alt+Tab 返回 CS2 并执行。');
                  }
                })
                .catch(() => setError('复制或切回游戏未完成，请重试并核对剪贴板。'))
            }
          >
            {copied ? '已复制，请前往游戏执行' : '复制并前往游戏'}
          </Button>
        </section>
      ) : null}
      {error ? <StatusBanner tone="warning">{error}</StatusBanner> : null}
      <Button variant="primary" disabled={busy || !view || stale} onClick={() => void submit()}>
        {busy
          ? '正在提交…'
          : saved
            ? '复查并重试提示接收'
            : registerCurrent
              ? '登记当前连接并启用提示'
              : '提交 GoTV'}
      </Button>
      {window.__TAURI_INTERNALS__ && (runtime?.active || runtime?.pending) ? (
        <Button
          disabled={stopping}
          onClick={() => {
            setStopping(true);
            setError('');
            void desktopInvoke('observer_command', { action: 'stop' })
              .catch((reason: unknown) => setError(String(reason)))
              .finally(() => setStopping(false));
          }}
        >
          {stopping ? '正在停止接收…' : '停止提前提示接收'}
        </Button>
      ) : null}
      {saved ? (
        <Button
          disabled={busy}
          onClick={() => {
            setSaved(false);
            setInput('');
            setRevision(undefined);
            setEarlyEndpoint('');
            setProgramEndpoint('');
            setManualCommand('');
            setCopied(false);
            intent.current = crypto.randomUUID();
          }}
        >
          填写下一次连接
        </Button>
      ) : null}
    </main>
  );
}
