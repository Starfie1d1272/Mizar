import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { PROGRAM_SCENES } from '@mizar/protocol/program-scenes';
import type { OperatorPayload } from '@mizar/protocol/operator';
import type { ProgramPayload } from '@mizar/protocol/program';
import { getRadarArtwork } from '@mizar-hud/radar-view';
import { useBpSession } from '../bp/client';
import { useLocalChannelClient } from '../realtime';
import { Radar } from '../program/widgets/radar/Radar';
import { hasRadarViewFrame } from '../program/widgets/radar/adapter';
import { desktopInvoke, selectProgramScene, useProgramScenes } from './client';
import { workspaceCurrentPov, workspaceIssues, workspaceMatchScore } from './model';
import { useObsStatus } from './obs-client';
import {
  useLocalRead,
  useLocalReadWithTime,
  openTool,
  productionAction,
  type Production,
  command,
} from '../preparation/client';
import { Button, StatusPill, Dialog } from '../ui';
import { ProductionStatus } from './ProductionStatus';
import { RivalHubLiveSourcePanel } from './RivalHubLiveSourcePanel';
import { SpectatorHudCommands } from '../preparation/SpectatorHudCommands';
import { LocalOverlayControls } from '../preparation/LocalOverlayControls';
import { ScenePreviewViewport } from '../preparation/ScenePreviewViewport';
import './workspace.css';

const previewSettled = () => {};

async function openPreparation(path: string) {
  if (window.__TAURI_INTERNALS__) await desktopInvoke('open_main', { path });
  else window.open(path, 'mizar-preparation');
}

function ContextPanel({
  operator,
  program,
}: {
  readonly operator: OperatorPayload | null;
  readonly program: ProgramPayload | null;
}) {
  const match = operator?.matchContext.summary;
  const score = workspaceMatchScore(program);
  const pov = workspaceCurrentPov(program);
  const issues = workspaceIssues(operator);
  return (
    <section className="workspace-context" aria-label="当前比赛与制作状态">
      <div className="workspace-section-heading">
        <small title={match?.competitionName}>
          {match ? `${match.competitionName} · ${match.format.toUpperCase()}` : '当前比赛 · 待选择'}
        </small>
        <Button onClick={() => void openPreparation('/matches')}>比赛资料</Button>
      </div>
      <div className="workspace-match-score">
        <strong title={score?.teamA.name ?? match?.entryAName}>
          {score?.teamA.name ?? match?.entryAName ?? '队伍 A'}
        </strong>
        <b aria-label="当前图回合比分">
          {score?.teamA.mapScore ?? '–'} : {score?.teamB.mapScore ?? '–'}
        </b>
        <strong title={score?.teamB.name ?? match?.entryBName}>
          {score?.teamB.name ?? match?.entryBName ?? '队伍 B'}
        </strong>
      </div>
      {score === null ? null : (
        <small className="workspace-score-detail">
          当前图 · {score.currentMapName ?? '等待比赛数据'}
          {score.seriesScoreText ? ` · 系列 ${score.seriesScoreText}` : ''}
        </small>
      )}
      <p className="workspace-pov">当前视角 · {pov ?? '等待观战数据'}</p>
      {issues.length > 0 ? (
        <div className="workspace-attention">
          <span role="status">有 {issues.length} 项需要处理</span>
          <Button onClick={() => void openTool('diagnostics')}>查看问题</Button>
          {operator?.identity.state === 'mismatch' ? (
            <Button onClick={() => void openPreparation('/matches?tab=roster')}>核对名单</Button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function ObsConfidence() {
  const { value: result, updatedAt } = useLocalReadWithTime<{
    preview: { scene: string; image: string } | null;
  }>('/local/v1/obs/confidence', 2000);
  return (
    <section className="workspace-confidence" aria-label="OBS 画面确认">
      {result?.preview ? (
        <>
          <img src={result.preview.image} alt={`OBS 画面确认：${result.preview.scene}`} />
          <small className="workspace-confidence__time">
            画面确认 ·{' '}
            {updatedAt
              ? new Date(updatedAt).toLocaleTimeString('zh-CN', { hour12: false })
              : '更新中'}
          </small>
        </>
      ) : (
        <div className="workspace-confidence__empty">
          <span>OBS 预览暂不可用</span>
          <Button onClick={() => void openPreparation('/settings?tab=obs')}>检查连接</Button>
        </div>
      )}
    </section>
  );
}

export function WorkspaceLeft() {
  const radar = useLocalChannelClient('radar');
  const operator = useLocalChannelClient('operator');
  const program = useLocalChannelClient('program');
  const state = useSyncExternalStore(
    operator.subscribe,
    operator.getSnapshot,
    operator.getSnapshot,
  );
  const programState = useSyncExternalStore(
    program.subscribe,
    program.getSnapshot,
    program.getSnapshot,
  );
  const radarState = useSyncExternalStore(radar.subscribe, radar.getSnapshot, radar.getSnapshot);
  const payload = state.state === 'live' ? (state.current?.payload ?? null) : null;
  const liveRadar = hasRadarViewFrame(radarState.state === 'live' ? radarState.current : null);
  const plannedMap =
    payload?.seriesProgress?.maps.find((map) => map.status === 'current') ??
    payload?.seriesProgress?.maps.find((map) => map.status === 'pending');
  const map = payload?.runtime.mapName ?? plannedMap?.mapName;
  const artwork = map ? getRadarArtwork(map)?.artwork.overview : null;
  return (
    <main className="workspace-left mizar-surface" aria-label="现场工作区">
      <div className="workspace-left__top">
        <header className="workspace-section-heading workspace-brand">
          <div className="workspace-brand__name">
            <img src="/brand/mizar-mark.svg" alt="" />
            <strong>MIZAR</strong>
          </div>
          <StatusPill tone={liveRadar ? 'success' : 'warning'}>
            {liveRadar ? '比赛数据正常' : '等待比赛数据'}
          </StatusPill>
        </header>
        <section className="workspace-radar" aria-label="比赛雷达">
          <header className="workspace-section-heading">
            <small>比赛雷达</small>
            <span>{map?.replace(/^de_/, '').toUpperCase() ?? '地图待确认'}</span>
          </header>
          <div className="workspace-radar__picture">
            {liveRadar ? (
              <Radar client={radar} zoomMode="full-map" />
            ) : (
              <div className="workspace-radar-placeholder" data-artwork={Boolean(artwork)}>
                {artwork ? (
                  <img src={artwork} alt={`${map} 地图底图，无实时选手标记`} />
                ) : (
                  <div className="workspace-radar-grid" aria-hidden="true">
                    <i />
                    <i />
                  </div>
                )}
                <div className="workspace-empty">
                  <strong>
                    {payload?.identity.state === 'mismatch' ? '等待核对比赛名单' : '等待 GSI 数据'}
                  </strong>
                  <p>
                    {artwork ? '地图底图 · 实时位置尚不可用' : '进入 CS2 观战后显示地图与选手位置'}
                  </p>
                  <Button onClick={() => void openPreparation('/settings?tab=gsi')}>
                    检查游戏连接
                  </Button>
                </div>
              </div>
            )}
          </div>
        </section>
        <ContextPanel
          operator={payload}
          program={programState.state === 'live' ? (programState.current?.payload ?? null) : null}
        />
        <ProductionStatus compact matchId={payload?.matchContext.summary?.matchId ?? null} />
      </div>
      <ObsConfidence />
    </main>
  );
}

export function WorkspaceDock() {
  const sceneState = useProgramScenes();
  const { snapshot: bp } = useBpSession();
  const obs = useObsStatus();
  const [message, setMessage] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(() => setMessage(''), 6000);
    return () => clearTimeout(timer);
  }, [message]);
  const production = useLocalRead<Production>('/local/v1/production');
  useEffect(() => {
    const hide = () => {
      void fetch('/local/v1/production', { cache: 'no-store' })
        .then((response) => response.json() as Promise<Production>)
        .then((current) =>
          command('/operator/production', { action: 'hide', expectedRevision: current.revision }),
        )
        .catch(() => setErrorMessage('工作区已隐藏，制作状态暂未同步。'));
    };
    window.addEventListener('mizar-hide', hide);
    return () => window.removeEventListener('mizar-hide', hide);
  }, []);
  async function action(run: () => Promise<unknown>, restoreFocus = false) {
    if (busy) return;
    setBusy(true);
    setMessage('');
    setErrorMessage('');
    try {
      await run();
      if (restoreFocus && window.__TAURI_INTERNALS__) {
        const focused = await desktopInvoke<boolean>('restore_cs2_focus');
        if (!focused) setMessage('操作已完成，未能将焦点交还 CS2。');
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '操作未完成。');
    } finally {
      setBusy(false);
    }
  }
  const mode = sceneState?.director?.mode;
  const connected = obs?.connection === 'connected';
  const next = PROGRAM_SCENES.find((scene) => scene.id === sceneState?.director?.next);
  const nextFrame = useMemo(
    () => (next ? { key: next.id, scene: next.id, src: next.path, immediate: true } : null),
    [next],
  );
  return (
    <main className="workspace-dock mizar-surface" aria-label="现场控制底栏">
      <section className="workspace-direction" aria-label="节目控制">
        <div className="workspace-section-heading">
          <strong>
            {PROGRAM_SCENES.find((scene) => scene.id === sceneState?.active)?.title ?? '等待同步'}
          </strong>
          <StatusPill tone={mode === 'blocked' ? 'warning' : 'info'}>
            {mode === 'auto'
              ? '自动编排'
              : mode === 'manual'
                ? '手动保持'
                : mode === 'blocked'
                  ? '自动暂停'
                  : '准备中'}
          </StatusPill>
          <Button
            disabled={busy || !sceneState || (mode !== 'manual' && mode !== 'blocked')}
            onClick={() =>
              sceneState &&
              void action(() =>
                command('/operator/program-director', {
                  action: 'resume',
                  expectedRevision: sceneState.revision,
                }),
              )
            }
          >
            恢复自动
          </Button>
        </div>
        <div className="workspace-scene-buttons" aria-label="手动切换场景">
          {PROGRAM_SCENES.map((scene) => (
            <Button
              key={scene.id}
              disabled={busy || !sceneState || !sceneState.available.includes(scene.id)}
              aria-pressed={sceneState?.active === scene.id}
              title={sceneState?.blocked?.[scene.id] ?? `手动切换到${scene.title}`}
              onClick={() =>
                sceneState &&
                void action(
                  () => selectProgramScene(scene.id, sceneState.revision),
                  scene.id === 'gameplay' || scene.id === 'bp',
                )
              }
            >
              {scene.title}
            </Button>
          ))}
        </div>
        <div className="workspace-next-preview" aria-label="下一个场景预览">
          {nextFrame ? <ScenePreviewViewport frame={nextFrame} onSettled={previewSettled} /> : null}
          <div>
            <small>下一场景</small>
            <strong>
              {next?.title ??
                (sceneState?.director?.nextStatus === 'complete' ? '本场结束' : '待确认')}
            </strong>
          </div>
        </div>
      </section>
      <section className="workspace-spectator" aria-label="观战控制">
        <div className="workspace-section-heading">
          <small>观战 · 本机</small>
          <Button disabled={busy} onClick={() => void action(() => openTool('bp'))}>
            BP 工作台
          </Button>
          {bp && bp.state !== 'hidden' && bp.projection ? (
            <span>
              BP · {bp.revealedCount} / {bp.projection.steps.length}
            </span>
          ) : null}
        </div>
        <SpectatorHudCommands compact onMessage={setMessage} />
        <p className="workspace-command-help">复制后在 CS2 控制台执行</p>
        <LocalOverlayControls onMessage={setMessage} />
      </section>
      <section className="workspace-production" aria-label="制作工具">
        <div className="workspace-section-heading">
          <small>制作工具</small>
          <span data-tone={connected ? 'success' : 'warning'}>
            {connected
              ? `OBS · ${obs.streaming ? '推流中' : '已连接'}`
              : obs?.connection === 'invalid_password'
                ? 'OBS · 密码无效'
                : obs?.connection === 'password_required'
                  ? 'OBS · 需要密码'
                  : 'OBS · 未连接'}
          </span>
        </div>
        <Button
          disabled={busy}
          onClick={() => void action(() => openPreparation('/settings?tab=obs'))}
        >
          OBS 配置
        </Button>
        <p className="workspace-obs-live">
          推流 · {connected ? (obs.streaming ? '进行中' : '未启动') : '无法确认'} · 录制 ·{' '}
          {connected ? (obs.recording ? '进行中' : '未启动') : '无法确认'}
        </p>
        <div className="workspace-tools">
          <Button disabled={busy} onClick={() => void action(() => openTool('hud'))}>
            HUD 编辑器
          </Button>
          <Button disabled={busy} onClick={() => void action(() => openTool('diagnostics'))}>
            运行诊断
          </Button>
          <Button
            disabled={busy || !window.__TAURI_INTERNALS__}
            onClick={() => void action(() => desktopInvoke('restore_layout'), true)}
          >
            恢复布局
          </Button>
          <Button
            disabled={!production || busy}
            onClick={() => production && void action(() => productionAction('hide', production))}
          >
            隐藏工作区
          </Button>
        </div>
      </section>
      <footer className="workspace-message" role="status">
        <span title={sceneState?.director?.reason ?? undefined}>
          {sceneState?.director?.reason || '点击场景切换播出 · 切换后保持手动'}
        </span>
        {errorMessage ? (
          <button
            className="workspace-error"
            onClick={() => setDetailsOpen(true)}
            title={errorMessage}
            aria-label="查看错误详情"
          >
            <span role="alert">{errorMessage}</span>
          </button>
        ) : null}
        {message ? (
          <span className="workspace-feedback" role="status">
            {message}
          </span>
        ) : null}
        <div className="workspace-footer-actions">
          <RivalHubLiveSourcePanel compact action={action} onMessage={setMessage} />
          <small className="workspace-exit-help">关闭游戏并恢复配置</small>
          <Button
            className="workspace-exit"
            disabled={!production || busy}
            aria-busy={busy}
            onClick={() => production && void action(() => productionAction('finish', production))}
          >
            退出工作台
          </Button>
        </div>
      </footer>
      <Dialog open={detailsOpen} title="操作未完成" onClose={() => setDetailsOpen(false)}>
        <p>{errorMessage}</p>
        <p>{sceneState?.director?.reason}</p>
        <Button onClick={() => setDetailsOpen(false)}>关闭详情</Button>
      </Dialog>
    </main>
  );
}

export function WorkspacePreview() {
  return (
    <div className="workspace-preview">
      <WorkspaceLeft />
      <div className="workspace-preview__game">CS2 游戏画面</div>
      <WorkspaceDock />
    </div>
  );
}
