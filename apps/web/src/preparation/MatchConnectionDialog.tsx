import { ControlTask } from '../debug/control-task';
import { useEffect, useRef, useState } from 'react';
import { parseObserverConnection } from '@mizar/protocol/assist';
import { Button, Field, Select, StatusBanner } from '../ui';
import { command, useLocalRead, useLocalReadWithTime } from './client';
import { desktopInvoke } from '../workspace/client';
import { ToolShell } from '../patterns';
import { usePreparationStatus } from './AutomaticPreparation';
import {
  observerFailureReason,
  observerNeedsRecovery,
  requireConnectionRevision,
  resumeObserverReceiver,
  type ObserverRuntimeView,
  type ConnectionPreparationView,
} from './observer-preparation';
import './match-connection.css';

/** One persistent tool owns only its draft. The observer owns connection intent and revision. */
export function MatchConnectionDialog() {
  const [registeredAt, setRegisteredAt] = useState<number | null>(null);
  const read = useLocalReadWithTime<ConnectionPreparationView>(
    '/local/v1/observer-assist',
    2000,
    registeredAt ?? 0,
  );
  const view = read.value;
  const runtime = useLocalRead<ObserverRuntimeView>('/local/v1/observer');
  const [stopping, setStopping] = useState(false);
  const [input, setInput] = useState('');
  const [earlyEndpoint, setEarlyEndpoint] = useState('');
  const [programEndpoint, setProgramEndpoint] = useState('');
  const [nextMap, setNextMap] = useState(false);
  const [registerCurrent, setRegisterCurrent] = useState<boolean | null>(null);
  const [revision, setRevision] = useState<string>();
  const saved = registeredAt !== null;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [manual, setManual] = useState<{ revision: string; command: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const operation = useRef(false);
  const [intent, setIntent] = useState<string | null>(null);
  const preparation = usePreparationStatus();
  if (intent === null && view) {
    // Reopening the tool resumes the owner's accepted identity, never a new connect.
    setIntent(view.mapConnection?.id ?? crypto.randomUUID());
    setRegisterCurrent(view.suggestedConnectionMode === 'register-current');
    if (view.mapConnection) setRegisteredAt(read.updatedAt ?? 0);
  }
  const submitted = saved && view?.mapConnection?.id === intent ? view.mapConnection : null;
  const stale = Boolean(!saved && view && revision && view.revision !== revision);
  const replaced = Boolean(
    registeredAt !== null &&
    read.updatedAt !== null &&
    read.updatedAt >= registeredAt &&
    !submitted,
  );
  const currentTarget = submitted?.nextMap ?? nextMap;
  const currentMode =
    submitted?.mode ??
    (nextMap
      ? 'connect'
      : registerCurrent === null
        ? (view?.suggestedConnectionMode ?? 'connect')
        : registerCurrent
          ? 'register-current'
          : 'connect');
  const enabled = view?.settings.enabled === true;
  const paused = enabled && Boolean(view?.receiverPaused);
  const failed =
    enabled && !paused && !runtime?.pending && Boolean(runtime && observerNeedsRecovery(runtime));
  const ended = Boolean(
    runtime && !runtime.pending && !failed && ['ended', 'stopped'].includes(runtime.health.state),
  );
  const canReturn = Boolean(
    !busy &&
    submitted &&
    (!enabled || (!paused && !failed && (runtime?.health.state === 'live' || ended))),
  );
  const manualCommand =
    submitted && manual?.revision === view?.revision && !runtime?.programCommandQueued
      ? manual?.command
      : null;
  useEffect(() => {
    if (!submitted?.id || currentMode !== 'connect' || busy || manualCommand) return;
    let active = true;
    const readCommand = async () => {
      // Manual instructions depend on the Host's control capability, not whether the
      // optional hint receiver has started or has acquired its own game lease.
      if (window.__TAURI_INTERNALS__) {
        const mode = await desktopInvoke<{ useMulnx: boolean | null }>('observer_command', {
          action: 'connection-mode',
        });
        if (
          mode.useMulnx === null ||
          (mode.useMulnx &&
            view?.gameAutomation?.autoConnect &&
            !['not-sent', 'unknown', 'unavailable'].includes(runtime?.gameCommandState ?? ''))
        )
          return;
      }
      const expectedRevision = requireConnectionRevision(view?.revision);
      const value = (await command('/operator/observer-assist', {
        action: 'copy-connection',
        expectedRevision,
      })) as unknown as { command: string };
      if (active) {
        setManual({ revision: expectedRevision, command: value.command });
        setCopied(false);
      }
    };
    void readCommand().catch((reason: unknown) => {
      if (active) setError(reason instanceof Error ? reason.message : '游戏命令读取失败，请重试。');
    });
    return () => {
      active = false;
    };
  }, [
    submitted?.id,
    currentMode,
    busy,
    manualCommand,
    view?.revision,
    view?.gameAutomation?.autoConnect,
    read.updatedAt,
    runtime?.gameCommandState,
  ]);
  const submit = async () => {
    if (operation.current || !intent) return;
    operation.current = true;
    setBusy(true);
    setError('');
    const task = new ControlTask('observer_map_connection', 'user', {
      intentId: intent,
      mode: currentMode,
      nextMap: currentTarget,
      expectedRevision: revision ?? view?.revision,
      retry: saved,
    });
    try {
      let currentRevision = requireConnectionRevision(
        saved ? view?.revision : (revision ?? view?.revision),
      );
      if (!saved) {
        if (!input.trim()) throw new Error('请填写赛事方提供的 GoTV 命令。');
        const result = (await command(
          '/operator/observer-assist',
          {
            action: 'map-connection',
            id: intent,
            mode: currentMode,
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
        setRegisteredAt(Date.now());
        task.event('registered', { revision: currentRevision });
      }
      if (saved && view) {
        const result = await resumeObserverReceiver(view, task);
        if (result?.warning) setError(result.warning);
      } else if (window.__TAURI_INTERNALS__) {
        const result = await desktopInvoke<{ warning?: string | null }>(
          'observer_command',
          {
            action: 'start-configured',
            expectedRevision: currentRevision,
          },
          task,
        );
        if (result.warning) setError(result.warning);
      }
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
    <ToolShell title="GoTV 连接" responsive>
      <main className="workbench-tool match-connection-dialog">
        <h1>GoTV 连接</h1>
        <Select
          label="连接目标"
          value={currentTarget ? 'next' : 'current'}
          disabled={busy || saved}
          onChange={(event) => {
            if (!revision) setRevision(view?.revision);
            setNextMap(event.target.value === 'next');
            setRegisterCurrent(event.target.value === 'next' ? false : null);
            setIntent(crypto.randomUUID());
          }}
        >
          <option value="current">本图</option>
          <option value="next">下一图</option>
        </Select>
        <Field
          label="GoTV 命令"
          value={saved ? (view?.connection?.earlyEndpoint ?? '') : input}
          autoComplete="off"
          disabled={busy || saved}
          placeholder="connect IP:27025; password 密码"
          message="粘贴赛事方提供的 GoTV 命令；两个地址中请选择 27025。"
          onChange={(event) => {
            if (!revision) setRevision(view?.revision);
            if (registerCurrent === null) setRegisterCurrent(currentMode === 'register-current');
            setInput(event.target.value);
            setIntent(crypto.randomUUID());
          }}
        />
        <details>
          <summary>其他端口设置</summary>
          <Field
            label="自定义提前提示端点（可选）"
            value={earlyEndpoint}
            disabled={busy || saved}
            onChange={(event) => {
              if (!revision) setRevision(view?.revision);
              if (registerCurrent === null) setRegisterCurrent(currentMode === 'register-current');
              setEarlyEndpoint(event.target.value);
              setIntent(crypto.randomUUID());
            }}
          />
          <Field
            label="自定义游戏端点（可选）"
            value={programEndpoint}
            disabled={busy || saved}
            onChange={(event) => {
              if (!revision) setRevision(view?.revision);
              if (registerCurrent === null) setRegisterCurrent(currentMode === 'register-current');
              setProgramEndpoint(event.target.value);
              setIntent(crypto.randomUUID());
            }}
          />
          <p>
            支持的双端口赛事使用 27025 接收提前提示、27026
            连接游戏。其他端口不会被自动改写，请核对赛事方说明。
          </p>
        </details>
        {!currentTarget && !saved ? (
          <Select
            label="本次操作"
            value={currentMode}
            disabled={busy}
            onChange={(event) => {
              if (!revision) setRevision(view?.revision);
              setRegisterCurrent(event.target.value === 'register-current');
              setIntent(crypto.randomUUID());
            }}
          >
            <option value="connect">连接或重新连接游戏</option>
            <option value="register-current">我已在观战，只开启提前提示</option>
          </Select>
        ) : null}
        {stale ? (
          <StatusBanner tone="warning">
            比赛或连接设置已变化。请核对草稿目标后重新确认。
            <Button
              disabled={busy}
              onClick={() => {
                setRevision(view!.revision);
                setNextMap(false);
                setRegisterCurrent(null);
                setRegisteredAt(null);
                setManual(null);
                setIntent(crypto.randomUUID());
              }}
            >
              将草稿用于本图
            </Button>
          </StatusBanner>
        ) : null}
        {saved && !replaced && (!failed || !error) ? (
          <p role={failed ? 'alert' : 'status'}>
            {!enabled
              ? '连接已保存。提前提示当前未开启。'
              : paused
                ? '提前提示接收已暂停，游戏连接与本图地址保留。'
                : failed
                  ? observerFailureReason(runtime!)
                  : ended
                    ? '本次观战连接已结束。'
                    : runtime?.pending
                      ? '正在准备提前提示…'
                      : runtime?.health.state === 'live'
                        ? '正在接收比赛数据，提前提示会在数据就绪后显示。'
                        : preparation?.running
                          ? '连接已保存，游戏就绪后会继续。'
                          : '连接已保存，正在等待比赛数据。'}
          </p>
        ) : null}
        {replaced ? (
          <StatusBanner tone="info">
            此连接已被新的操作替换。填写新连接前请核对当前目标。
          </StatusBanner>
        ) : null}
        {saved &&
        !replaced &&
        runtime?.gameCommandState &&
        runtime.gameCommandState !== 'queued' ? (
          <StatusBanner tone="warning">
            {runtime.gameCommandState === 'unknown'
              ? '游戏连接命令可能已送达，请先在 CS2 内核对。重新提交可能中断当前观战。'
              : runtime.gameCommandState === 'not-sent'
                ? '游戏连接命令未送达。可重新填写连接后再试，或在游戏内手动连接。'
                : '无法安全保存游戏连接的提交状态，未自动发送。可在游戏内手动连接。'}
          </StatusBanner>
        ) : null}
        {manualCommand ? (
          <section>
            <p>复制并返回游戏，在控制台粘贴并按回车。若控制台已关闭，按 ~ 打开：</p>
            <p>{manualCommand}</p>
            <Button
              onClick={() =>
                void command('/operator/observer-assist', {
                  action: 'copy-connection',
                  expectedRevision: manual!.revision,
                })
                  .then((value) =>
                    navigator.clipboard.writeText(
                      (value as unknown as { command: string }).command,
                    ),
                  )
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
        {canReturn ? (
          <Button
            variant="primary"
            onClick={() => {
              if (window.__TAURI_INTERNALS__)
                void desktopInvoke<boolean>('restore_cs2_focus')
                  .then((focused) => {
                    if (!focused) setError('请用 Alt+Tab 返回 CS2。');
                  })
                  .catch(() => setError('请用 Alt+Tab 返回 CS2。'));
              else window.location.assign('/workspace');
            }}
          >
            {window.__TAURI_INTERNALS__ ? '返回游戏' : '返回工作台'}
          </Button>
        ) : (
          <Button
            variant="primary"
            disabled={
              busy ||
              stopping ||
              !view ||
              !intent ||
              stale ||
              replaced ||
              Boolean(
                saved && (!submitted || runtime?.pending || (!paused && preparation?.running)),
              )
            }
            onClick={() => void submit()}
          >
            {busy
              ? '正在提交…'
              : saved
                ? paused
                  ? '恢复提前提示接收'
                  : failed
                    ? '重试提前提示接收'
                    : '复查提示接收'
                : currentMode === 'register-current'
                  ? '开启提前提示'
                  : '提交 GoTV'}
          </Button>
        )}
        {window.__TAURI_INTERNALS__ &&
        enabled &&
        !paused &&
        (runtime?.active || runtime?.pending || submitted) ? (
          <Button
            disabled={stopping || replaced || !view}
            onClick={() => {
              setStopping(true);
              setError('');
              void desktopInvoke('observer_command', {
                action: 'stop',
                expectedRevision: requireConnectionRevision(view?.revision),
              })
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
              setRegisteredAt(null);
              setNextMap(false);
              setRegisterCurrent(
                runtime?.gameCommandState === 'not-sent' || runtime?.gameCommandState === 'unknown'
                  ? false
                  : null,
              );
              setInput('');
              setRevision(undefined);
              setEarlyEndpoint('');
              setProgramEndpoint('');
              setManual(null);
              setCopied(false);
              setIntent(crypto.randomUUID());
            }}
          >
            {runtime?.gameCommandState === 'not-sent'
              ? '重新填写并重试游戏连接'
              : runtime?.gameCommandState === 'unknown'
                ? '核对后重新填写连接'
                : '填写下一次连接'}
          </Button>
        ) : null}
      </main>
    </ToolShell>
  );
}
