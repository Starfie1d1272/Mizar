import { useCallback, useEffect, useRef, useState } from 'react';
import { getBuiltinPresets } from '@mizar/hud-config';
import { Button, Field, Panel, Select, StatusBanner } from '../ui';
import { desktopInvoke } from '../workspace/client';
import { mutateHudConfig, useHudConfigEditorClient } from '../realtime/hud-config-client';
import { checkObsBeforeLaunch, useLocalRead } from './client';
import { useCs2Status } from './cs2-status';
import type { DemoTestView, SelectedDemo } from './demo-test';

export function DemoTestPanel() {
  const trial = useLocalRead<DemoTestView>('/local/v1/demo-test', 1000);
  const [expanded, setExpanded] = useState(false);
  const shown = expanded || trial?.active === true;
  const editor = useHudConfigEditorClient(shown);
  const { status: game } = useCs2Status();
  const [selected, setSelected] = useState<SelectedDemo | null>(null);
  const [preset, setPreset] = useState<string | null>(null);
  const [teamAName, setTeamAName] = useState('队伍 A');
  const [teamBName, setTeamBName] = useState('队伍 B');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const operation = useRef(false);
  const form = useRef<HTMLFormElement>(null);
  const attemptedEntry = useRef<string | null>(null);
  const activePreset = preset ?? editor.document?.activePreset.sourceId ?? '';
  const desktop = Boolean(window.__TAURI_INTERNALS__);

  useEffect(() => {
    if (expanded && !trial?.active) form.current?.querySelector('input')?.focus();
  }, [expanded, trial?.active]);

  const run = useCallback(async (action: () => Promise<unknown>) => {
    if (operation.current) return;
    operation.current = true;
    setBusy(true);
    setMessage('');
    try {
      await action();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '试播操作未完成，请重试。');
    } finally {
      operation.current = false;
      setBusy(false);
    }
  }, []);

  // Native verifies ownership again. A PID snapshot does not authorize playback.
  useEffect(() => {
    const requestId = trial?.requestId;
    if (
      !desktop ||
      trial?.phase !== 'starting' ||
      !game?.running ||
      !requestId ||
      attemptedEntry.current === requestId ||
      busy
    )
      return;
    attemptedEntry.current = requestId;
    void run(() => desktopInvoke('enter_demo_test', { requestId }));
  }, [desktop, trial?.phase, trial?.requestId, game?.running, busy, run]);

  return (
    <Panel>
      <h2>Demo 试播</h2>
      <p>开播前，用本地 Demo 检查 HUD、游戏画面和 OBS 音画。</p>
      {!shown ? (
        <Button disabled={!desktop} onClick={() => setExpanded(true)}>
          准备 Demo 试播
        </Button>
      ) : trial?.active ? (
        <>
          <p>
            {trial.teamAName} vs {trial.teamBName} · BO1 · 试播资料
          </p>
          <p aria-live="polite">
            {trial.phase === 'starting'
              ? game?.running
                ? '游戏已运行，正在打开试播工作台。'
                : '启动请求已提交，等待 CS2。'
              : trial.phase === 'playing'
                ? trial.dataReady
                  ? '已收到新鲜游戏数据，可检查 HUD。'
                  : '游戏已运行，等待有效观战数据。'
                : '试播数据已隔离，等待关闭游戏并恢复配置。'}
          </p>
          <p>游戏运行不代表所选 Demo 已加载。名单与地图确认后，才可恢复自动编排。</p>
          {trial.phase === 'playing' || (trial.phase === 'starting' && game?.running) ? (
            <Button
              disabled={busy || !desktop}
              onClick={() =>
                void run(() => desktopInvoke('enter_demo_test', { requestId: trial.requestId }))
              }
            >
              打开试播工作台
            </Button>
          ) : null}
          <Button
            disabled={busy || !desktop}
            onClick={() =>
              void run(() => desktopInvoke('finish_demo_test', { requestId: trial.requestId }))
            }
          >
            {trial.phase === 'recovery' || trial.phase === 'stopping'
              ? '重试结束并恢复'
              : '结束试播并恢复设置'}
          </Button>
        </>
      ) : (
        <form
          ref={form}
          onSubmit={(event) => {
            event.preventDefault();
            void run(async () => {
              if (!selected || !editor.revision || !activePreset) return;
              if (!(await checkObsBeforeLaunch(true))) return;
              if (activePreset !== editor.document?.activePreset.sourceId) {
                const result = await mutateHudConfig({
                  kind: 'activate-preset',
                  sourceId: activePreset,
                  expectedEditorRevision: editor.revision,
                });
                editor.applyResponse(result.editor);
              }
              await desktopInvoke('start_demo_test', {
                token: selected.token,
                teamAName,
                teamBName,
              });
              setSelected(null);
            });
          }}
        >
          <Field
            label="队伍 A"
            value={teamAName}
            maxLength={100}
            required
            disabled={busy}
            onChange={(event) => setTeamAName(event.target.value)}
          />
          <Field
            label="队伍 B"
            value={teamBName}
            maxLength={100}
            required
            disabled={busy}
            onChange={(event) => setTeamBName(event.target.value)}
          />
          <p>默认 BO1，无需赛事、名单或 BP。试播不会保存到比赛库。</p>
          <Select
            label="试播 HUD"
            value={activePreset}
            disabled={busy || editor.status !== 'ready'}
            onChange={(event) => setPreset(event.target.value)}
          >
            {[...getBuiltinPresets(), ...(editor.document?.customPresets ?? [])].map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </Select>
          <p>开始时启用所选 HUD；结束试播后保留这一选择。</p>
          <Button
            disabled={busy || !desktop}
            onClick={() =>
              void run(async () => {
                const next = await desktopInvoke<SelectedDemo | null>('select_demo_file');
                if (next !== null) setSelected(next);
              })
            }
          >
            选择本地 Demo
          </Button>
          <p>{selected?.name ?? '尚未选择 .dem 文件'}</p>
          <p>请先在 OBS 停止推流。已打开的外部 CS2 请自行退出；本次受管游戏请先结束并恢复设置。</p>
          <Button
            type="submit"
            variant="primary"
            disabled={
              busy ||
              !selected ||
              !desktop ||
              trial === null ||
              editor.status !== 'ready' ||
              !teamAName.trim() ||
              !teamBName.trim()
            }
          >
            启动 Demo 试播
          </Button>
        </form>
      )}
      {!desktop ? <p>请在 Mizar 桌面准备中心选择并启动本地 Demo。</p> : null}
      {message ? <StatusBanner tone="danger">{message}</StatusBanner> : null}
      {shown && editor.error ? <StatusBanner tone="warning">{editor.error}</StatusBanner> : null}
    </Panel>
  );
}
