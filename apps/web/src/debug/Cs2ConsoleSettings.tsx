import { useEffect, useRef, useState } from 'react';
import { Button, Field, StatusBanner } from '../ui';
import { desktopInvoke } from '../workspace/client';
import { ControlTask } from './control-task';

interface ConsoleStatus {
  enabled: boolean;
  generation: string | null;
  revocationPending?: boolean;
  runtime?: { phase?: string } | null;
}
export function Cs2ConsoleSettings() {
  const desktop = Boolean(window.__TAURI_INTERNALS__);
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<ConsoleStatus | null>(null);
  const [draft, setDraft] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [readError, setReadError] = useState('');
  const [saveError, setSaveError] = useState('');
  const [saved, setSaved] = useState(false);
  const [reload, setReload] = useState(0);
  const epoch = useRef(0);
  const saving = useRef(false);
  useEffect(() => {
    if (!desktop || !open) return;
    let active = true;
    const read = async () => {
      if (saving.current) return;
      const version = epoch.current;
      const task = new ControlTask('cs2_console_settings_read', 'system', {});
      try {
        const value = await desktopInvoke<ConsoleStatus>('cs2_console_status', {}, task);
        task.finish('confirmed', { enabled: value.enabled, phase: value.runtime?.phase });
        if (active && version === epoch.current) {
          setStatus(value);
          setReadError('');
        }
      } catch (error) {
        task.fail(error);
        if (active && version === epoch.current)
          setReadError('技术日志设置读取失败，请重新打开此项或导出诊断报告。');
      }
    };
    void read();
    const interval = setInterval(() => void read(), 10_000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [desktop, open, reload]);
  if (!desktop) return null;
  const enabled = draft ?? status?.enabled ?? false;
  const dirty =
    status !== null &&
    (enabled !== status.enabled || (!enabled && status.revocationPending === true));
  const phase = status?.runtime?.phase;
  const phaseLabel = !status
    ? '读取状态待确认'
    : !status.enabled
      ? '已关闭'
      : phase === 'reading'
        ? '正在观察技术日志'
        : phase === 'unavailable'
          ? '暂时无法读取，原因已保存到诊断报告'
          : '等待受管游戏日志';
  async function save() {
    if (!status || busy || !dirty) return;
    const task = new ControlTask('cs2_console_capture_consent', 'user', {
      enabled: status.enabled,
      requested: enabled,
    });
    epoch.current++;
    saving.current = true;
    setBusy(true);
    setSaveError('');
    setSaved(false);
    try {
      const value = await desktopInvoke<ConsoleStatus>(
        'set_cs2_console_capture',
        { enabled, expectedGeneration: status.generation },
        task,
      );
      setStatus(value);
      setDraft(null);
      setSaved(true);
      task.finish('confirmed', { enabled: value.enabled, phase: value.runtime?.phase });
    } catch (error) {
      task.fail(error);
      setSaveError('技术日志设置未能完整保存，请重新读取设置后重试。');
      setStatus(null);
      setReload((value) => value + 1);
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }
  return (
    <details onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>CS2 技术日志（高级）</summary>
      <p>
        默认关闭。开启后，仅在 Mizar
        核实本次受管游戏身份时保存已识别的技术行，跳过旧内容、聊天和未知行。
      </p>
      <p>
        游戏会另外写入本机 console.log，可能包含聊天并持续增长。关闭仅停止 Mizar
        读取；已发出的游戏日志开关到下次启动才移除。Mizar 不清空或删除游戏日志。
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <Field
          type="checkbox"
          label="允许记录受管 CS2 技术日志"
          checked={enabled}
          disabled={!status || busy}
          onChange={(event) => {
            setDraft(event.target.checked);
            setSaved(false);
            setSaveError('');
          }}
        />
        <p>{phaseLabel}</p>
        {readError ? <StatusBanner tone="danger">{readError}</StatusBanner> : null}
        {saveError ? <StatusBanner tone="danger">{saveError}</StatusBanner> : null}
        {status?.revocationPending ? (
          <StatusBanner tone="warning">
            当前已停止读取，但关闭状态未能持久保存，请在重启前重试。
          </StatusBanner>
        ) : null}
        {saved ? (
          <StatusBanner tone="success">
            {status?.enabled
              ? '已保存。首次开启需下次由 Mizar 启动游戏后生效。'
              : '已停止 Mizar 读取。'}
          </StatusBanner>
        ) : null}
        <Button type="button" disabled={busy} onClick={() => setReload((value) => value + 1)}>
          重新读取设置
        </Button>
        <Button type="submit" disabled={!dirty || busy}>
          {busy ? '保存中…' : '保存技术日志设置'}
        </Button>
      </form>
    </details>
  );
}
