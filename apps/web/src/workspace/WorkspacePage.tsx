import { cancelProductionEntry, retryPendingPreparation } from '../preparation/client';
import { useRadarViewSource } from '../realtime/radar-view-source';
import { MatchConnectionControl } from './MatchConnectionControl';
import { ObserverHints } from './ObserverHints';
import { ReviewDialog, closeReviewWindow } from './ReviewDialog';
import { PreflightReview } from './PreflightReview';
import { RosterCapture } from '../preparation/RosterCapture';
import { DesktopCanvas } from '../patterns/DesktopCanvas';
import { CameraControls } from '../orchestration/CameraControls';
import type { OrchestrationView } from '@mizar/protocol/orchestration';
import type { ProductionGuidance } from '@mizar/protocol/program-scenes';
import type {
  ConnectionPreparationView,
  ObserverRuntimeView,
} from '../preparation/observer-preparation';
import { MusicControls } from '../music/MusicControls';
import { ObsOutputControls } from './ObsOutputControls';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { PROGRAM_SCENES } from '@mizar/protocol/program-scenes';
import type { ContextEnvelope } from '@mizar/core/match-context';
import type { MatchDocumentV1 } from '@mizar/protocol/context';
import type { OperatorPayload, SeriesBindingView } from '@mizar/protocol/operator';
import type { ProgramPayload, ProgramSnapshot } from '@mizar/protocol/program';
import { getRadarArtwork } from '@mizar-hud/radar-view';
import { useBpSession } from '../bp/client';
import { useLocalChannelClient } from '../realtime';
import { Radar } from '@mizar/hud-view';
import { hasRadarViewFrame } from '@mizar/hud-view';
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
import { Button, StatusPill, StatusBanner, Dialog, Select } from '../ui';
import { ProductionStatus } from './ProductionStatus';
import { LiveRosterAlert } from './LiveRosterAlert';
import { SyncHealthAlert, type SyncHealth } from './SyncHealthAlert';
import { RivalHubLiveSourcePanel } from './RivalHubLiveSourcePanel';
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
  connectionInRadar,
}: {
  readonly operator: OperatorPayload | null;
  readonly program: ProgramPayload | null;
  readonly programCursor: ProgramSnapshot['cursor'] | null;
  readonly connectionInRadar: boolean;
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
  const seriesBinding = useLocalRead<{ binding: SeriesBindingView | null }>(
    match ? '/local/v1/series-binding' : null,
    3000,
  )?.binding;
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
        {!connectionInRadar ? <MatchConnectionControl /> : null}
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
          matchId={operator?.matchContext.summary?.matchId}
          isSource={Boolean(
            connection?.activeMatchId &&
            connection.activeSourceMatchId === connection.activeMatchId,
          )}
          onOpen={openPreparation}
        />
      ) : null}
      {seriesBinding?.ownership?.status === 'attention' ? (
        <StatusBanner tone="warning">
          {seriesBinding.ownership.reason === 'previous_execution'
            ? '当前游戏执行属于上一场，本场结果与同步待确认。'
            : seriesBinding.ownership.reason === 'recovery_unverified'
              ? '恢复记录缺少当前执行的归属证明，本场结果与同步待确认。'
              : '新地图执行的比赛归属待确认。'}{' '}
          <Button
            onClick={() => {
              setIssueError(null);
              void openPreparation('/matches#series-binding').catch((error: unknown) =>
                setIssueError({
                  key: issueKey,
                  message: error instanceof Error ? error.message : '处理页面无法打开，请重试。',
                }),
              );
            }}
          >
            查看处理方式
          </Button>
          {visibleIssueError ? <span role="alert">{visibleIssueError}</span> : null}
        </StatusBanner>
      ) : seriesBinding?.ownership?.status === 'associated' ? (
        <StatusPill tone="success">地图执行已关联本场</StatusPill>
      ) : null}
      {program?.map.phase !== 'warmup' ? (
        <LiveRosterAlert
          alert={rosterAlert}
          matchId={operator?.matchContext.summary?.matchId}
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
  const connection = useLocalRead<ConnectionPreparationView>('/local/v1/observer-assist');
  const observer = useLocalRead<ObserverRuntimeView & { programCommandQueued?: boolean }>(
    '/local/v1/observer',
  );
  const guidance = useLocalRead<ProductionGuidance>('/local/v1/production-guidance');
  const radar = useLocalChannelClient('radar');
  const radarSource = useRadarViewSource(radar);
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
    (guidance?.phase === 'map_end'
      ? payload?.seriesProgress?.maps.find((map) => map.status === 'pending')
      : payload?.seriesProgress?.maps.find((map) => map.status === 'current')) ??
    payload?.seriesProgress?.maps.find((map) => map.status === 'pending');
  const map =
    guidance?.phase === 'map_end'
      ? plannedMap?.mapName
      : (payload?.runtime.mapName ?? plannedMap?.mapName);
  const artwork = map ? getRadarArtwork(map)?.artwork.overview : null;
  const interrupted =
    guidance?.phase !== 'map_end' &&
    guidance?.phase !== 'match_end' &&
    payload?.runtime.telemetryFreshness === 'stale' &&
    !connection?.waitingForMap &&
    !observer?.programCommandQueued;
  const connectionInRadar =
    !liveRadar &&
    guidance?.phase !== 'match_end' &&
    (guidance?.phase === 'map_end' || payload?.runtime.telemetryFreshness !== 'fresh') &&
    !interrupted;
  return (
    <main className="workspace-left mizar-surface" aria-label="现场工作区">
      <div className="workspace-left__top">
        <section className="workspace-radar" aria-label="比赛雷达">
          <div className="workspace-radar__picture">
            {liveRadar ? (
              <Radar source={radarSource} zoomMode="full-map" />
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
                    {guidance?.phase === 'match_end'
                      ? '比赛已结束'
                      : guidance?.phase === 'map_end' && connection?.waitingForMap
                        ? '等待本图数据'
                        : guidance?.phase === 'map_end'
                          ? plannedMap
                            ? `准备第 ${plannedMap.mapOrder} 图`
                            : '准备下一图'
                          : payload?.runtime.telemetryFreshness === 'fresh'
                            ? '本图已连接 · 等待雷达画面'
                            : observer?.programCommandQueued
                              ? '等待本图数据'
                              : payload?.runtime.telemetryFreshness === 'stale' &&
                                  !connection?.waitingForMap
                                ? '游戏数据已中断'
                                : '等待第一图 GOTV'}
                  </strong>
                  <p>
                    {guidance?.phase === 'match_end'
                      ? '请核对直播与录像状态'
                      : guidance?.phase === 'map_end' && connection?.waitingForMap
                        ? '连接已提交，请等待游戏数据'
                        : guidance?.phase === 'map_end'
                          ? '填写本图新的 GOTV'
                          : payload?.runtime.telemetryFreshness === 'fresh'
                            ? '等待雷达画面更新'
                            : observer?.programCommandQueued
                              ? '连接已提交，请等待游戏数据'
                              : '连接 GOTV 后显示比赛画面'}
                  </p>
                  {interrupted ? (
                    <Button onClick={() => void openPreparation('/settings?tab=gsi')}>
                      检查游戏连接
                    </Button>
                  ) : connectionInRadar ? (
                    <MatchConnectionControl primary />
                  ) : null}
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
              connectionInRadar={connectionInRadar}
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
  const [entryNotice, setEntryNotice] = useState('');
  const [dockDetail, setDockDetail] = useState<'notices' | 'display' | 'tools' | null>(null);
  useEffect(() => {
    let changed = false;
    const status = (event: Event) => {
      changed = true;
      setEntryNotice(String((event as CustomEvent).detail ?? ''));
    };
    window.addEventListener('mizar-entry-status', status);
    if (window.__TAURI_INTERNALS__)
      void desktopInvoke<string>('workbench_status')
        .then((message) => {
          if (!changed) setEntryNotice(message);
        })
        .catch(() => {});
    return () => window.removeEventListener('mizar-entry-status', status);
  }, []);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const layoutRequest = useRef(0);
  const [overlayRecovering, setOverlayRecovering] = useState(false);
  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(() => setMessage(''), 6000);
    return () => clearTimeout(timer);
  }, [message]);
  const production = useLocalRead<Production>('/local/v1/production');
  const guidance = useLocalRead<ProductionGuidance>('/local/v1/production-guidance');
  const { status: cs2 } = useCs2Status();
  const orchestration = useLocalRead<OrchestrationView>('/local/v1/orchestration');
  const showCamera = Boolean(cs2?.preferMulnx || orchestration?.status.connected);
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
    <main
      className="workspace-dock mizar-surface"
      data-camera={showCamera}
      aria-label="现场控制底栏"
    >
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
          {guidance?.phase === 'pre_match' ? (
            <Select
              label="热身播出"
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
              <option value="waiting">等待画面</option>
              <option value="gameplay">游戏画面</option>
            </Select>
          ) : null}
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
        {showCamera ? (
          <div role="region" aria-label="运镜控制">
            <CameraControls workspace />
          </div>
        ) : null}
        <Button onClick={() => setDockDetail('display')}>本机显示</Button>
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
        <RivalHubLiveSourcePanel compact action={action} onMessage={setMessage} />
        {entryNotice ||
        obs?.findings.some((finding) => finding.code === 'audio_teamspeak_compatibility') ? (
          <Button onClick={() => setDockDetail('notices')}>
            {entryNotice ? '启动准备 · 查看状态' : '声音兼容提示'}
          </Button>
        ) : null}
        <Button onClick={() => setDockDetail('tools')}>更多工具</Button>
      </section>
      <Dialog open={dockDetail === 'tools'} title="更多工具" onClose={() => setDockDetail(null)}>
        <div className="workspace-tools">
          {showCamera ? (
            <Button onClick={() => void action(() => openPreparation('/settings?tab=camera'))}>
              配置运镜
            </Button>
          ) : null}
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
            onClick={() =>
              void action(async () => {
                const request = ++layoutRequest.current;
                const result = await desktopInvoke<string>('restore_layout');
                if (result === 'panels') {
                  setMessage('工作台面板布局请求已提交。');
                  return;
                }
                setMessage('布局请求已提交，游戏窗口对齐结果仍待确认。');
                void (async () => {
                  for (let attempt = 0; attempt < 32; attempt++) {
                    await new Promise((resolve) => setTimeout(resolve, 1000));
                    const status = await desktopInvoke<{
                      layoutPending: boolean;
                      visible: boolean;
                      found: boolean;
                      managed: boolean;
                      message?: string | null;
                      geometry?: { preserveSettings?: boolean; alignmentRetries?: number };
                    }>('cs2_host_status').catch(() => null);
                    if (request !== layoutRequest.current) return;
                    if (!status || status.layoutPending) continue;
                    if (!status.visible) return;
                    if (status.managed) {
                      setMessage('已确认 CS2 窗口对齐；工作台面板布局请求已提交。');
                      return;
                    }
                    if (
                      !status.found ||
                      status.geometry?.preserveSettings ||
                      status.geometry?.alignmentRetries === 0
                    ) {
                      setMessage('');
                      setErrorMessage(
                        status.geometry?.preserveSettings
                          ? '本次启动保留原游戏设置，未接管游戏窗口布局。需要自动布局时请先正常退出游戏，在准备中心完成恢复后选择自动设置启动。'
                          : status.message ||
                              (!status.found
                                ? '尚未找到 CS2。打开游戏后再恢复布局。'
                                : '工作台面板布局请求已提交，CS2 窗口对齐尚未确认。'),
                      );
                      return;
                    }
                  }
                  if (request === layoutRequest.current)
                    setMessage('布局请求已提交，CS2 窗口对齐尚未确认。');
                })();
              })
            }
          >
            恢复布局
          </Button>
          <Button
            disabled={busy || !window.__TAURI_INTERNALS__}
            aria-busy={overlayRecovering}
            onClick={() =>
              void action(async () => {
                setOverlayRecovering(true);
                try {
                  const result = await desktopInvoke<string>('recover_program_overlay');
                  setMessage(result);
                } finally {
                  setOverlayRecovering(false);
                }
              })
            }
          >
            {overlayRecovering ? '正在重建本机 HUD…' : '恢复本机 HUD'}
          </Button>
          <Button
            disabled={!production || busy}
            onClick={() => production && void action(() => productionAction('hide', production))}
          >
            隐藏工作区
          </Button>
        </div>
      </Dialog>
      <Dialog open={dockDetail === 'display'} title="本机显示" onClose={() => setDockDetail(null)}>
        <LocalOverlayControls onMessage={setMessage} />
      </Dialog>
      <Dialog
        open={dockDetail === 'notices'}
        title="准备与声音提示"
        onClose={() => setDockDetail(null)}
      >
        {entryNotice ? (
          <StatusBanner tone="warning">
            {entryNotice} <Button onClick={() => setEntryNotice('')}>关闭</Button>{' '}
            <Button onClick={() => void action(() => retryPendingPreparation())}>重试准备</Button>{' '}
            <Button onClick={() => void action(() => cancelProductionEntry())}>取消准备</Button>
          </StatusBanner>
        ) : null}
        {obs?.findings
          .filter((finding) => finding.code === 'audio_teamspeak_compatibility')
          .map((finding) => (
            <StatusBanner key={finding.code} tone="warning">
              {finding.message}
            </StatusBanner>
          ))}
      </Dialog>
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
          <Button
            className="workspace-exit"
            disabled={!production || busy || Boolean(exit?.busy)}
            aria-busy={busy || Boolean(exit?.busy)}
            onClick={() =>
              production &&
              void action(async () => {
                await cancelProductionEntry().catch(() => {});
                await productionAction('finish', production);
              }, true)
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
        showCloseButton={false}
        actions={
          <>
            {exit?.message ? (
              <Button
                onClick={() =>
                  void openPreparation('/').catch((reason: unknown) =>
                    setErrorMessage(
                      reason instanceof Error ? reason.message : '准备中心无法打开。',
                    ),
                  )
                }
              >
                打开准备中心
              </Button>
            ) : null}
            <Button onClick={() => setDetailsOpen(false)}>关闭详情</Button>
          </>
        }
      >
        <p>{visibleError}</p>
        <p>
          {exit?.message
            ? `${workspaceExitLabel(exit.stage)}：按原因处理后，在准备中心重试；再次失败时导出诊断包反馈。`
            : exit?.windowMessage
              ? '按上面的窗口控制原因处理，再点恢复布局或切回工作台重试；正常退出本次游戏后，在准备中心完成恢复。'
              : sceneState?.director?.reason}
        </p>
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
        actions={
          <>
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
              onClick={() =>
                void openTool('diagnostics').catch((reason) => setError(String(reason)))
              }
            >
              运行诊断
            </Button>
          </>
        }
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
