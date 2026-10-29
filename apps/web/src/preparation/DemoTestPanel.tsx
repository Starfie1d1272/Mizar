import { CameraAudition } from '../orchestration/CameraAudition';
import { useCallback, useEffect, useRef, useState } from 'react';
import { getBuiltinPresets } from '@mizar/hud-config';
import { Button, Field, Panel, Select, StatusBanner } from '../ui';
import { desktopInvoke } from '../workspace/client';
import { mutateHudConfig, useHudConfigEditorClient } from '../realtime/hud-config-client';
import { checkObsBeforeLaunch, enterDemoTest, useLocalRead } from './client';
import { useCs2Status } from './cs2-status';
import type { DemoTestView, SelectedDemo } from './demo-test';

export function DemoTestPanel({ forceExpanded = false }: { forceExpanded?: boolean }) {
  const trial = useLocalRead<DemoTestView>('/local/v1/demo-test', 1000);
  const [expanded, setExpanded] = useState(() =>
    new URLSearchParams(window.location.search).has('demoTest'),
  );
  const shown = forceExpanded || expanded || trial?.active === true;
  const editor = useHudConfigEditorClient(shown);
  const { status: game } = useCs2Status();
  const [selected, setSelected] = useState<SelectedDemo | null>(null);
  const [cameraTrial, setCameraTrial] = useState(false);
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
    if (expanded && !trial?.active)
      form.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
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

  const start = (preserveSettings = false) =>
    run(async () => {
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
        cameraTrial,
        ...(preserveSettings ? { preserveSettings: true } : {}),
      });
      setSelected(null);
    });
  const startDisabled =
    busy ||
    !selected ||
    !desktop ||
    trial === null ||
    editor.status !== 'ready' ||
    !teamAName.trim() ||
    !teamBName.trim();

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const entryController = useRef<AbortController | null>(null);
  useEffect(() => {
    if (!forceExpanded) entryController.current?.abort();
    return () => entryController.current?.abort();
  }, [forceExpanded]);
  const enter = useCallback((requestId: string) => {
    const controller = new AbortController();
    entryController.current = controller;
    return enterDemoTest(requestId, undefined, () => mounted.current, controller.signal);
  }, []);

  useEffect(() => {
    const requestId = trial?.requestId;
    if (
      !desktop ||
      trial?.phase !== 'starting' ||
      !requestId ||
      !game?.mulnxLaunchResumable ||
      game.running
    )
      return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const resume = async () => {
      try {
        await desktopInvoke('resume_demo_test', { requestId });
      } catch {
        /* The game may still be starting. */
      }
      if (active) timer = setTimeout(() => void resume(), 5000);
    };
    void resume();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [desktop, trial?.phase, trial?.requestId, game?.mulnxLaunchResumable, game?.running]);

  // Native verifies ownership again. A PID snapshot does not authorize playback.
  useEffect(() => {
    const requestId = trial?.requestId;
    if (
      !desktop ||
      (!forceExpanded && !expanded) ||
      trial?.phase !== 'starting' ||
      !game?.running ||
      !requestId ||
      attemptedEntry.current === requestId ||
      busy
    )
      return;
    attemptedEntry.current = requestId;
    void run(() => enter(requestId));
  }, [
    desktop,
    forceExpanded,
    expanded,
    trial?.phase,
    trial?.requestId,
    game?.running,
    busy,
    run,
    enter,
  ]);

  const Container = forceExpanded ? 'div' : Panel;
  return (
    <Container id="demo-test" className="preparation-demo-test" data-expanded={shown}>
      {!forceExpanded ? <h2>Demo 试播</h2> : null}
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
                : '请先退出 CS2，再重试恢复。'}
          </p>
          {trial.phase === 'starting' || (trial.phase === 'playing' && !trial.dataReady) ? (
            <p>游戏已运行，请在 CS2 检查 Demo 播放画面。</p>
          ) : trial.phase === 'playing' ? (
            <p>试播保持手动编排，可检查 HUD、场景与 OBS 音画。</p>
          ) : (
            <p>恢复完成后即可开始正式比赛。</p>
          )}
          <div className="preparation-actions">
            {trial.phase === 'playing' || (trial.phase === 'starting' && game?.running) ? (
              <Button
                variant="primary"
                disabled={busy || !desktop}
                onClick={() => void run(() => enter(trial.requestId!))}
              >
                返回试播工作台
              </Button>
            ) : null}
            <Button
              disabled={busy || !desktop}
              onClick={() =>
                void run(() => desktopInvoke('finish_demo_test', { requestId: trial.requestId }))
              }
            >
              {trial.phase === 'recovery' || trial.phase === 'stopping'
                ? '重试恢复'
                : '结束试播并恢复设置'}
            </Button>
          </div>
          {trial.phase === 'playing' &&
          trial.dataReady &&
          trial.requestId &&
          game?.demoCameraRequestId === trial.requestId ? (
            <details>
              <summary>筛选运镜镜头</summary>
              <CameraAudition />
            </details>
          ) : null}
          <p>关闭此窗口不会结束试播。</p>
        </>
      ) : (
        <form
          ref={form}
          onSubmit={(event) => {
            event.preventDefault();
            void start();
          }}
        >
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
          <Select
            label="试播用途"
            value={cameraTrial ? 'camera' : 'hud'}
            disabled={busy}
            onChange={(event) => setCameraTrial(event.target.value === 'camera')}
          >
            <option value="hud">HUD 试播</option>
            <option value="camera">运镜筛选（MulNX）</option>
          </Select>
          <p>默认沿用当前 HUD，使用“队伍 A / 队伍 B”作为试播队名。</p>
          <details>
            <summary>调整队名与 HUD</summary>
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
            <p>BO1 · 试播资料不入比赛库</p>
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
            <p>更换 HUD 后，该样式在试播结束后仍会保留。</p>
          </details>

          {game?.running || game?.pending ? (
            <p>请先退出当前 CS2 并恢复设置，再开始试播。</p>
          ) : (
            <p>开始前会检查 OBS；正在推流时请先停止。</p>
          )}
          <Button type="submit" variant="primary" disabled={startDisabled}>
            启动 Demo 试播
          </Button>
          {game?.canPreserve ? (
            <>
              <p>
                配置接管未完成，可保持原游戏设置继续；此时不应用自动画质、帧率、窗口布局和本机 HUD
                覆盖。
              </p>
              <Button disabled={startDisabled} onClick={() => void start(true)}>
                保持原设置启动试播
              </Button>
            </>
          ) : null}
        </form>
      )}
      {!desktop ? <p>请在 Mizar 桌面准备中心选择并启动本地 Demo。</p> : null}
      {message ? <StatusBanner tone="danger">{message}</StatusBanner> : null}
      {shown && !trial?.active && editor.error ? (
        <StatusBanner tone="warning">画面设置暂不可用，请检查本地服务后重试。</StatusBanner>
      ) : null}
    </Container>
  );
}
