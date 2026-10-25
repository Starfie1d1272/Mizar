import { ObserverHints } from './ObserverHints';
import { ReviewDialog, closeReviewWindow } from './ReviewDialog';
import { PreflightReview } from './PreflightReview';
import { RosterCapture } from '../preparation/RosterCapture';
import { DesktopCanvas } from '../patterns/DesktopCanvas';
import { CameraControls } from '../orchestration/CameraControls';
import { MusicControls } from '../music/MusicControls';
import { ObsOutputControls } from './ObsOutputControls';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { PROGRAM_SCENES } from '@mizar/protocol/program-scenes';
import type { ContextEnvelope } from '@mizar/core/match-context';
import type { MatchDocumentV1 } from '@mizar/protocol/context';
import type { OperatorPayload } from '@mizar/protocol/operator';
import type { ProgramPayload, ProgramSnapshot } from '@mizar/protocol/program';
import { getRadarArtwork } from '@mizar-hud/radar-view';
import { useBpSession } from '../bp/client';
import { useLocalChannelClient } from '../realtime';
import { Radar } from '../program/widgets/radar/Radar';
import { hasRadarViewFrame } from '../program/widgets/radar/adapter';
import {
  desktopInvoke,
  HostWindowControlError,
  selectProgramScene,
  useProgramScenes,
} from './client';
import {
  workspaceCurrentPov,
  workspaceIssues,
  workspaceMatchScore,
  type WorkspaceIssue,
} from './model';
import { workspaceLiveRosterAlert, type LiveRosterConnection } from './live-roster-model';
import { useObsStatus } from './obs-client';
import {
  useLocalRead,
  useLocalReadWithTime,
  openTool,
  productionAction,
  type Production,
  command,
} from '../preparation/client';
import { Button, StatusPill, Dialog, Select } from '../ui';
import { ProductionStatus } from './ProductionStatus';
import { LiveRosterAlert } from './LiveRosterAlert';
import { SyncHealthAlert, type SyncHealth } from './SyncHealthAlert';
import { RivalHubLiveSourcePanel } from './RivalHubLiveSourcePanel';
import { SpectatorHudCommands } from '../preparation/SpectatorHudCommands';
import { LocalOverlayControls } from '../preparation/LocalOverlayControls';
import {
  useCs2Status,
  useWorkspaceExitStatus,
  workspaceExitLabel,
  type WorkspaceExitStatus,
} from '../preparation/cs2-status';
import { ScenePreviewViewport } from '../preparation/ScenePreviewViewport';
import './workspace.css';

const previewSettled = () => {};

async function openPreparation(path: string) {
  if (window.__TAURI_INTERNALS__) await desktopInvoke('open_main', { path });
  else if (!window.open(path, 'mizar-preparation'))
    throw new Error('处理页面未能打开，请允许弹出窗口后重试。');
}

function ContextPanel({
  operator,
  program,
  programCursor,
}: {
  readonly operator: OperatorPayload | null;
  readonly program: ProgramPayload | null;
  readonly programCursor: ProgramSnapshot['cursor'] | null;
}) {
  const match = operator?.matchContext.summary;
  const score = workspaceMatchScore(program);
  const pov = workspaceCurrentPov(program);
  const issues = workspaceIssues(operator);
  const document = useLocalRead<ContextEnvelope<MatchDocumentV1>>(
    operator?.matchContext.rosterAuthority === 'rivalhub' ? '/local/v1/match-document' : null,
  );
  const connection = useLocalRead<LiveRosterConnection & { syncHealth?: SyncHealth }>(
    operator?.matchContext.rosterAuthority === 'rivalhub' ? '/local/v1/rivalhub-connection' : null,
    3000,
  );
  const rosterAlert = workspaceLiveRosterAlert(
    operator,
    program,
    document?.document ?? null,
    connection,
    programCursor,
  );
  const [captureOpen, setCaptureOpen] = useState(false);
  const [issuesOpen, setIssuesOpen] = useState(
    () =>
      window.location.pathname === '/workspace/review' &&
      new URLSearchParams(window.location.search).get('kind') === 'issues',
  );
  const [issueError, setIssueError] = useState<{ key: string; message: string } | null>(null);
  const attentionIssues = rosterAlert
    ? issues.filter((issue) => issue.id !== 'steam64' && issue.id !== 'roster')
    : issues;
  const issueKey = `${issues.map((issue) => issue.id).join(',')}:${rosterAlert?.key ?? ''}`;
  const visibleIssueError = issueError?.key === issueKey ? issueError.message : null;
  async function openIssue(issue: WorkspaceIssue) {
    const path = issue.path;
    setIssueError(null);
    try {
      if (issue.run === 'refresh-rivalhub') await command('/operator/rivalhub/refresh');
      else if (path === '/debug' && window.__TAURI_INTERNALS__) await openTool('diagnostics');
      else await openPreparation(path);
    } catch (error) {
      setIssueError({
        key: issueKey,
        message: error instanceof Error ? error.message : '处理页面无法打开，请重试。',
      });
    }
  }
  return (
    <section className="workspace-context" aria-label="当前比赛与制作状态">
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
      <div className="workspace-context__meta">
        <small className="workspace-score-detail" title={score?.seriesScoreText ?? undefined}>
          {score?.currentMapName ?? '地图待确认'}
          {score?.seriesScoreText ? ` · 系列 ${score.seriesScoreText}` : ''}
        </small>
        <p className="workspace-pov" title={pov ?? undefined}>
          视角 · {pov ?? '等待观战数据'}
        </p>
      </div>
      <div className="workspace-context__actions">
        <Button onClick={() => void openPreparation('/matches')}>比赛资料</Button>
        {operator?.matchContext.rosterAuthority !== 'rivalhub' ? (
          <>
            <Button onClick={() => setCaptureOpen(true)}>
              {match ? '识别服务器首发' : '从服务器创建本地比赛'}
            </Button>
            <Dialog
              open={captureOpen}
              title={match ? '核对现场首发' : '从服务器创建本地比赛'}
              modal={false}
              className="workspace-recovery workspace-roster-capture"
              onClose={() => setCaptureOpen(false)}
            >
              <p>连接服务器并进入观战后，核对双方十人名单，再确认保存。</p>
              <RosterCapture
                key={match?.matchId ?? 'empty'}
                create={!match}
                autoOpen
                {...(match ? { names: { a: match.entryAName, b: match.entryBName } } : {})}
              />
            </Dialog>
          </>
        ) : null}
        <PreflightReview
          operator={operator}
          program={program}
          cursor={programCursor}
          connection={connection}
          onOpen={openPreparation}
        />
      </div>
      {program?.map.phase !== 'warmup' ? (
        <SyncHealthAlert
          health={connection?.syncHealth}
          isSource={Boolean(
            connection?.activeMatchId &&
            connection.activeSourceMatchId === connection.activeMatchId,
          )}
          onOpen={openPreparation}
        />
      ) : null}
      {program?.map.phase !== 'warmup' ? (
        <LiveRosterAlert
          alert={rosterAlert}
          suppressAutomatic={connection?.syncHealth?.status === 'attention'}
          recovered={
            operator?.runtime.telemetryFreshness === 'fresh' &&
            operator.identity.state === 'matched' &&
            operator.activeLineup.state === 'complete' &&
            operator.activeLineup.retainedCount === 0 &&
            !operator.identity.issues.some((issue) => issue.code === 'lineup_differs_from_expected')
          }
          onReview={() =>
            void openIssue({
              id: 'live-roster',
              summary: '上场选手／账号与网站首发不一致',
              detail: '',
              action: '核对网站名单',
              path: '/matches?tab=roster',
            })
          }
          error={visibleIssueError}
        />
      ) : null}
      {attentionIssues.length > 0 ? (
        <div className="workspace-attention" data-multiple={attentionIssues.length > 1}>
          <span role="status" title={attentionIssues.map((issue) => issue.summary).join('；')}>
            <Button
              variant="secondary"
              className="workspace-issue-summary"
              onClick={() => setIssuesOpen(true)}
            >
              {attentionIssues[0]!.summary}
            </Button>
            {attentionIssues.length > 1 ? ` · 共 ${attentionIssues.length} 项` : ''}
          </span>
          <Button onClick={() => void openIssue(attentionIssues[0]!)}>
            {attentionIssues[0]!.action}
          </Button>
          {issues.length > 1 ? <Button onClick={() => setIssuesOpen(true)}>全部问题</Button> : null}
        </div>
      ) : null}
      {visibleIssueError && issues.length > 0 ? <p role="alert">{visibleIssueError}</p> : null}
      <ReviewDialog
        kind="issues"
        open={issuesOpen && issues.length > 0}
        title="本场需要处理"
        modal={false}
        className="workspace-recovery"
        onClose={() => setIssuesOpen(false)}
      >
        {issues.map((issue) => (
          <section key={issue.id} aria-label={issue.summary}>
            <h3>{issue.summary}</h3>
            <p>{issue.detail}</p>
            <Button onClick={() => void openIssue(issue)}>{issue.action}</Button>
          </section>
        ))}
        {visibleIssueError ? <p role="alert">{visibleIssueError}</p> : null}
      </ReviewDialog>
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

function WorkspaceLeftContent() {
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
        <section className="workspace-radar" aria-label="比赛雷达">
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
                    {payload?.identity.state === 'mismatch' ? '等待核对比赛资料' : '等待 GSI 数据'}
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
        <div className="workspace-left__details">
          <ObserverHints />
          <div className="workspace-left__context">
            <MusicControls compact />
            <ContextPanel
              operator={payload}
              programCursor={
                programState.state === 'live' ? (programState.current?.cursor ?? null) : null
              }
              program={
                programState.state === 'live' ? (programState.current?.payload ?? null) : null
              }
            />
            <ProductionStatus compact matchId={payload?.matchContext.summary?.matchId ?? null} />
          </div>
        </div>
      </div>
      <ObsConfidence />
    </main>
  );
}

function WorkspaceDockContent() {
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
  const { status: cs2 } = useCs2Status();
  const exit = useWorkspaceExitStatus();
  const visibleError = exit?.message || errorMessage || exit?.windowMessage || '';
  useEffect(() => {
    const hide = () => {
      void fetch('/local/v1/production', { cache: 'no-store', signal: AbortSignal.timeout(5000) })
        .then((response) => response.json() as Promise<Production>)
        .then((current) =>
          current.mode === 'preparation'
            ? undefined
            : command('/operator/production', {
                action: 'hide',
                expectedRevision: current.revision,
              }),
        )
        .catch(() => setErrorMessage('工作区已隐藏，制作状态暂未同步。'));
    };
    window.addEventListener('mizar-hide', hide);
    return () => window.removeEventListener('mizar-hide', hide);
  }, []);
  async function action(run: () => Promise<unknown>, reportsExit = false) {
    if (busy) return;
    setBusy(true);
    setMessage('');
    setErrorMessage('');
    try {
      await run();
    } catch (error) {
      if (error instanceof HostWindowControlError) return;
      const detail = error instanceof Error ? error.message : '操作未完成。';
      const shared = reportsExit
        ? await desktopInvoke<WorkspaceExitStatus>('workspace_exit_status').catch(() => null)
        : null;
      // Host owns exit errors. Do not leave a second, stale copy after recovery.
      if (shared?.message !== detail) setErrorMessage(detail);
    } finally {
      setBusy(false);
    }
  }
  const mode = sceneState?.director?.mode;
  const connected = obs?.connection === 'connected';
  const next = PROGRAM_SCENES.find((scene) => scene.id === sceneState?.director?.next);
  const nextFrame = useMemo(
    () =>
      mode === 'auto' && next
        ? { key: next.id, scene: next.id, src: next.path, immediate: true }
        : null,
    [next, mode],
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
                sceneState && void action(() => selectProgramScene(scene.id, sceneState.revision))
              }
            >
              {scene.title}
            </Button>
          ))}
        </div>
        <div className="workspace-next-preview" aria-label="下一个场景预览">
          <Select
            label="热身画面"
            disabled={busy || !sceneState?.director}
            value={sceneState?.director?.warmupScene ?? 'waiting'}
            onChange={(event) => {
              const scene = event.currentTarget.value;
              if (sceneState && (scene === 'waiting' || scene === 'gameplay'))
                void action(() =>
                  command('/operator/program-director', {
                    action: 'warmup',
                    scene,
                    expectedRevision: sceneState.revision,
                  }),
                );
            }}
          >
            <option value="waiting">赛前等待</option>
            <option value="gameplay">游戏画面</option>
          </Select>
          {nextFrame ? <ScenePreviewViewport frame={nextFrame} onSettled={previewSettled} /> : null}
          <div>
            <small>{mode === 'manual' || mode === 'blocked' ? '自动推进已暂停' : '下一场景'}</small>
            <strong>
              {mode === 'manual'
                ? '恢复自动后继续编排'
                : mode === 'blocked'
                  ? '处理问题后恢复自动'
                  : (next?.title ??
                    (sceneState?.director?.nextStatus === 'complete' ? '本场结束' : '待确认'))}
            </strong>
            {mode === 'auto' && sceneState?.director?.nextReason ? (
              <small>{sceneState.director.nextReason}</small>
            ) : null}
            {mode === 'blocked' && sceneState?.director?.reason ? (
              <small>{sceneState.director.reason}</small>
            ) : null}
          </div>
        </div>
      </section>
      <section className="workspace-camera" aria-label="运镜控制">
        <div className="workspace-section-heading">
          <strong>运镜</strong>
          <Button
            onClick={() => void action(() => openPreparation('/settings?tab=music&section=camera'))}
          >
            配置运镜
          </Button>
        </div>
        <CameraControls workspace />
      </section>
      <section className="workspace-spectator" aria-label="观战控制">
        <div className="workspace-section-heading">
          {exit?.windowMessage ? (
            <Button
              className="workspace-window-warning"
              aria-label="窗口控制需要处理"
              onClick={() => {
                if (exit?.message && window.__TAURI_INTERNALS__) {
                  void desktopInvoke('open_tool', { tool: 'review', presetId: 'exit' }).catch(() =>
                    setDetailsOpen(true),
                  );
                } else setDetailsOpen(true);
              }}
            >
              窗口告警
            </Button>
          ) : (
            <small>观战 · 本机</small>
          )}
          <Button
            disabled={busy || !window.__TAURI_INTERNALS__}
            aria-busy={busy}
            onClick={() =>
              void action(async () => {
                const focused = await desktopInvoke<boolean>('restore_cs2_focus');
                if (!focused) setMessage('操作已完成，未能将焦点交还 CS2。');
              })
            }
          >
            返回游戏
          </Button>
          <Button disabled={busy} onClick={() => void action(() => openTool('bp'))}>
            地图资料
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
          <span data-tone={connected ? 'success' : 'warning'}>
            {connected
              ? 'OBS · 已连接'
              : obs?.connection === 'invalid_password'
                ? 'OBS · 密码无效'
                : obs?.connection === 'password_required'
                  ? 'OBS · 需要密码'
                  : 'OBS · 未连接'}
          </span>
          <Button
            disabled={busy}
            onClick={() => void action(() => openPreparation('/settings?tab=obs'))}
          >
            OBS 配置
          </Button>
        </div>
        <ObsOutputControls onError={setErrorMessage} />
        <div className="workspace-tools">
          <Button disabled={busy} onClick={() => void action(() => openTool('hud'))}>
            HUD 编辑器
          </Button>
          <Button
            onClick={() =>
              void openTool('diagnostics').catch((reason: unknown) =>
                setErrorMessage(reason instanceof Error ? reason.message : '诊断窗口无法打开。'),
              )
            }
          >
            运行诊断
          </Button>
          <Button
            disabled={busy || !window.__TAURI_INTERNALS__}
            onClick={() => void action(() => desktopInvoke('restore_layout'))}
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
        {visibleError ? (
          <button
            className="workspace-error"
            onClick={() => {
              if (exit?.message && window.__TAURI_INTERNALS__) {
                void desktopInvoke('open_tool', { tool: 'review', presetId: 'exit' }).catch(() =>
                  setDetailsOpen(true),
                );
              } else setDetailsOpen(true);
            }}
            title={visibleError}
            aria-label="查看错误详情"
          >
            <span role="alert">{visibleError}</span>
          </button>
        ) : null}
        {message ? (
          <span className="workspace-feedback" role="status">
            {message}
          </span>
        ) : null}
        <div className="workspace-footer-actions">
          <RivalHubLiveSourcePanel compact action={action} onMessage={setMessage} />
          <small className="workspace-exit-help">
            {exit?.busy
              ? workspaceExitLabel(exit.stage)
              : cs2?.borrowed
                ? '解除借用，游戏保持运行'
                : cs2?.preserveSettings
                  ? '关闭本次游戏，保留游戏设置'
                  : '关闭游戏并恢复配置'}
          </small>
          <Button
            disabled={busy}
            onClick={() =>
              void action(async () => {
                await command('/operator/diagnostics/report', {
                  category: 'other',
                  observedAt: new Date().toISOString(),
                });
                setMessage('问题时间已在本机诊断中保存；云端接收状态可在设置中查看。');
              })
            }
          >
            标记本场问题
          </Button>
          <Button
            className="workspace-exit"
            disabled={!production || busy || Boolean(exit?.busy)}
            aria-busy={busy || Boolean(exit?.busy)}
            onClick={() =>
              production && void action(() => productionAction('finish', production), true)
            }
          >
            {exit?.busy ? '正在退出…' : '退出工作台'}
          </Button>
        </div>
      </footer>
      <Dialog
        open={detailsOpen}
        modal={false}
        title={exit?.message ? '退出工作台需要处理' : '操作未完成'}
        onClose={() => setDetailsOpen(false)}
      >
        <p>{visibleError}</p>
        <p>
          {exit?.message
            ? `${workspaceExitLabel(exit.stage)}：按原因处理后，在准备中心重试；再次失败时导出诊断包反馈。`
            : exit?.windowMessage
              ? '按上面的窗口控制原因处理，再点恢复布局或切回工作台重试；正常退出本次游戏后，在准备中心完成恢复。'
              : sceneState?.director?.reason}
        </p>
        {exit?.message ? (
          <Button
            onClick={() =>
              void openPreparation('/').catch((reason: unknown) =>
                setErrorMessage(reason instanceof Error ? reason.message : '准备中心无法打开。'),
              )
            }
          >
            打开准备中心
          </Button>
        ) : null}
        <Button onClick={() => setDetailsOpen(false)}>关闭详情</Button>
      </Dialog>
    </main>
  );
}

export function WorkspaceLeft() {
  return (
    <DesktopCanvas kind="left">
      <WorkspaceLeftContent />
    </DesktopCanvas>
  );
}

export function WorkspaceDock() {
  return (
    <DesktopCanvas kind="dock">
      <WorkspaceDockContent />
    </DesktopCanvas>
  );
}

export function WorkspacePreview() {
  return (
    <DesktopCanvas kind="preview">
      <div className="workspace-preview">
        <WorkspaceLeftContent />
        <div className="workspace-preview__game">CS2 游戏画面</div>
        <WorkspaceDockContent />
      </div>
    </DesktopCanvas>
  );
}

function ExitReview() {
  const exit = useWorkspaceExitStatus();
  const [error, setError] = useState('');
  return (
    <div className="workspace-review-native">
      <Dialog
        open
        modal={false}
        title="退出工作台需要处理"
        className="workspace-review-dialog"
        onClose={() => void closeReviewWindow().catch((reason) => setError(String(reason)))}
      >
        <p>
          {exit
            ? (exit.message ??
              (exit.busy
                ? '正在处理，请等待结果。'
                : '退出异常已处理，请返回准备中心查看当前状态。'))
            : '正在读取退出结果…'}
        </p>
        {exit?.message ? (
          <p>
            {workspaceExitLabel(exit.stage)}尚未完成。请返回准备中心处理，备份和处理记录仍保留。
          </p>
        ) : null}
        <div className="preparation-actions">
          <Button
            variant="primary"
            onClick={() =>
              void openPreparation('/')
                .then(() => closeReviewWindow())
                .catch((reason) => setError(String(reason)))
            }
          >
            返回准备中心处理
          </Button>
          <Button
            onClick={() => void openTool('diagnostics').catch((reason) => setError(String(reason)))}
          >
            运行诊断
          </Button>
        </div>
        {error ? <p role="alert">{error}</p> : null}
      </Dialog>
    </div>
  );
}

export function WorkspaceReview() {
  if (new URLSearchParams(window.location.search).get('kind') === 'exit') return <ExitReview />;
  return (
    <div className="workspace-review-native">
      <WorkspaceLeftContent />
      <section className="workspace-review-empty">
        <h1>本场核对</h1>
        <p>当前没有需要处理的提醒，或数据仍在加载。</p>
        <Button onClick={() => void closeReviewWindow()}>关闭窗口</Button>
      </section>
    </div>
  );
}
