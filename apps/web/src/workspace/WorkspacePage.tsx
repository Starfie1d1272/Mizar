import { useEffect, useState, useSyncExternalStore } from 'react';
import { PROGRAM_SCENES } from '@mizar/protocol/program-scenes';
import type { OperatorPayload } from '@mizar/protocol/operator';
import type { ProgramPayload } from '@mizar/protocol/program';
import { useBpSession } from '../bp/client';
import { useLocalChannelClient } from '../realtime';
import { Radar } from '../program/widgets/radar/Radar';
import { desktopInvoke, selectProgramScene, useProgramScenes } from './client';
import { workspaceCurrentPov, workspaceIssues, workspacePhase } from './model';
import { obsCommand, useObsStatus } from './obs-client';
import { useLocalTournament } from '../preparation/tournament';
import {
  useLocalRead,
  openTool,
  productionAction,
  type Production,
  command,
} from '../preparation/client';
import type { OverlayPolicy } from '../preparation/PreparationPage';
import { Button } from '../ui';
import { RivalHubLiveSourcePanel } from './RivalHubLiveSourcePanel';
import './workspace.css';

const PHASE_LABEL = {
  pre_match: '赛前',
  bp: 'BP',
  live: '赛中',
  map_end: '地图结束 / 图间',
  match_end: '比赛结束',
} as const;

function useCs2HostStatus() {
  const [value, setValue] = useState<{
    found: boolean;
    managed: boolean;
    generation: number;
  } | null>(null);
  useEffect(() => {
    if (!window.__TAURI_INTERNALS__) return;
    let active = true;
    const refresh = () =>
      void desktopInvoke<{ found: boolean; managed: boolean; generation: number }>(
        'cs2_host_status',
      )
        .then((status) => {
          if (active) setValue(status);
        })
        .catch(() => {
          if (active) setValue(null);
        });
    refresh();
    const timer = setInterval(refresh, 1000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);
  return value;
}

function ContextPanel({
  operator,
  program,
}: {
  readonly operator: OperatorPayload | null;
  readonly program: ProgramPayload | null;
}) {
  const { snapshot: bp } = useBpSession();
  const obs = useObsStatus();
  const cs2 = useCs2HostStatus();
  const { view: tournament } = useLocalTournament();
  const phase = workspacePhase(operator, bp);
  const match = operator?.matchContext.summary;
  const series = operator?.seriesProgress;
  const completed = [...(series?.maps ?? [])].reverse().find((map) => map.status === 'completed');
  const next = series?.maps.find((map) => map.status === 'pending');
  const currentPov = workspaceCurrentPov(program);
  const issues = [
    ...workspaceIssues(operator),
    ...(obs?.sceneAligned === false ? ['OBS 当前场景与播出场景不一致，请检查配置。'] : []),
  ];
  return (
    <section className="workspace-context" aria-label="当前比赛与制作状态">
      <header>
        <small>当前比赛</small>
        <h1>{match ? `${match.competitionName} · ${match.format.toUpperCase()}` : '本地比赛'}</h1>
        <p>
          {match
            ? `${match.entryAName} ${series?.score.a ?? 0} : ${series?.score.b ?? 0} ${match.entryBName} · ${operator?.runtime.mapName ?? '等待地图'}`
            : '等待比赛信息'}
        </p>
      </header>
      {tournament && match && tournament.selectedMatchId === match.matchId ? (
        <section aria-label="前后比赛">
          {tournament.neighborhood.previous ? (
            <p>
              上一场 · {tournament.neighborhood.previous.entrants.a.name}{' '}
              {tournament.neighborhood.previous.scoreA ?? '–'} :{' '}
              {tournament.neighborhood.previous.scoreB ?? '–'}{' '}
              {tournament.neighborhood.previous.entrants.b.name}
            </p>
          ) : null}
          {tournament.neighborhood.next ? (
            <p>
              下一场 · {tournament.neighborhood.next.entrants.a.name} vs{' '}
              {tournament.neighborhood.next.entrants.b.name} ·{' '}
              {tournament.neighborhood.next.scheduledAt === null
                ? '时间待定'
                : new Date(tournament.neighborhood.next.scheduledAt).toLocaleString('zh-CN')}
            </p>
          ) : null}
        </section>
      ) : null}
      <section>
        <small>当前阶段</small>
        <h2>{PHASE_LABEL[phase]}</h2>
        {phase === 'bp' && bp?.projection ? (
          <p>
            已展示 {bp.revealedCount} / {bp.projection.steps.length} 项禁选
          </p>
        ) : null}
        {phase === 'live' && currentPov ? <p>当前 POV · {currentPov}</p> : null}
        {phase === 'map_end' ? (
          <p>
            {completed?.mapName ?? '上一图'}{' '}
            {completed?.finalScore ? `· ${completed.finalScore.a} : ${completed.finalScore.b}` : ''}
            {next ? ` · 下一图 ${next.mapName}` : ''}
          </p>
        ) : null}
        {phase === 'match_end' ? (
          <p>
            系列赛 {series?.score.a} : {series?.score.b}
          </p>
        ) : null}
        {phase === 'pre_match' || phase === 'bp' ? (
          <Button onClick={() => void openTool('bp')}>打开 BP 工作台</Button>
        ) : null}
      </section>
      {issues.length ? (
        <section className="workspace-issues" aria-label="需要处理">
          <small>需要处理</small>
          {issues.slice(0, 3).map((issue) => (
            <p key={issue}>{issue}</p>
          ))}
          {issues.length > 3 ? <p>另有 {issues.length - 3} 项问题</p> : null}
          <Button onClick={() => void openTool('diagnostics')}>打开运行诊断</Button>
          {operator?.identity.state === 'mismatch' ? (
            <Button
              onClick={() => {
                if (window.__TAURI_INTERNALS__)
                  void desktopInvoke('open_main', { path: '/matches?tab=roster' });
                else window.location.assign('/matches?tab=roster');
              }}
            >
              核对名单
            </Button>
          ) : null}
        </section>
      ) : null}
      {cs2?.found && !cs2.managed ? (
        <section className="workspace-issues" role="status">
          <p>CS2 窗口需要调整。请使用窗口化或无边框模式，再点击“恢复布局”。</p>
        </section>
      ) : null}
    </section>
  );
}

function ObsConfidence() {
  const result = useLocalRead<{ preview: { scene: string; image: string } | null }>(
    '/local/v1/obs/confidence',
    2000,
  );
  return (
    <section className="workspace-confidence" aria-label="OBS 画面确认">
      <small>OBS 画面确认</small>
      {result?.preview ? (
        <>
          <img src={result.preview.image} alt={`OBS 画面确认：${result.preview.scene}`} />
          <span>{result.preview.scene}</span>
        </>
      ) : (
        <p>OBS 画面确认暂不可用</p>
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
  return (
    <main className="workspace-left mizar-surface">
      <div className="workspace-radar">
        <Radar client={radar} zoomMode="auto" />
      </div>
      <ContextPanel
        operator={state.state === 'live' ? (state.current?.payload ?? null) : null}
        program={programState.state === 'live' ? (programState.current?.payload ?? null) : null}
      />
      <ObsConfidence />
    </main>
  );
}

export function WorkspaceDock() {
  const operator = useLocalChannelClient('operator');
  const program = useLocalChannelClient('program');
  const state = useSyncExternalStore(
    operator.subscribe,
    operator.getSnapshot,
    operator.getSnapshot,
  );
  const payload = state.state === 'live' ? state.current?.payload : undefined;
  const programState = useSyncExternalStore(
    program.subscribe,
    program.getSnapshot,
    program.getSnapshot,
  );
  const sceneState = useProgramScenes();
  const obs = useObsStatus();
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  const production = useLocalRead<Production>('/local/v1/production');
  const policy = useLocalRead<OverlayPolicy>('/local/v1/desktop-overlay');
  useEffect(() => {
    const hide = () => {
      void fetch('/local/v1/production', { cache: 'no-store' })
        .then((response) => response.json() as Promise<Production>)
        .then((current) =>
          command('/operator/production', { action: 'hide', expectedRevision: current.revision }),
        )
        .catch(() => setMessage('工作区已隐藏，制作状态暂未同步。'));
    };
    window.addEventListener('mizar-hide', hide);
    return () => window.removeEventListener('mizar-hide', hide);
  }, []);
  async function action(run: () => Promise<unknown>, restoreFocus = false) {
    if (busy) return;
    setBusy(true);
    setMessage('');
    try {
      await run();
      if (restoreFocus && window.__TAURI_INTERNALS__) {
        const focused = await desktopInvoke<boolean>('restore_cs2_focus');
        if (!focused) setMessage('操作已完成，未能将焦点交还 CS2。');
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '操作未完成。');
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="workspace-dock mizar-surface" aria-label="现场控制底栏">
      <section>
        <small>场景</small>
        <div className="workspace-scene-buttons">
          {PROGRAM_SCENES.map((scene) => (
            <Button
              key={scene.id}
              disabled={busy || !sceneState || !sceneState.available.includes(scene.id)}
              aria-pressed={sceneState?.active === scene.id}
              title={sceneState?.blocked?.[scene.id] ?? scene.title}
              onClick={() =>
                void action(
                  () => selectProgramScene(scene.id, sceneState!.revision),
                  scene.id === 'gameplay' || scene.id === 'bp',
                )
              }
            >
              {scene.title}
            </Button>
          ))}
        </div>
      </section>
      <section>
        <small>比赛</small>
        <strong>{payload?.runtime.mapName ?? '等待地图'}</strong>
        <span>
          {payload?.seriesProgress
            ? `${payload.seriesProgress.score.a} : ${payload.seriesProgress.score.b}`
            : '未绑定比赛'}
        </span>
        <Button onClick={() => void action(() => openTool('bp'))}>BP 工作台</Button>

        {production?.mode === 'live' ? (
          <RivalHubLiveSourcePanel
            action={action}
            onMessage={setMessage}
            currentMatchTitle={
              payload?.matchContext.summary
                ? `${payload.matchContext.summary.entryAName} vs ${payload.matchContext.summary.entryBName}`
                : null
            }
          />
        ) : null}
      </section>
      <section>
        <small>本机</small>
        <Button
          onClick={() =>
            void action(async () => {
              if (policy)
                await command('/operator/desktop-overlay', { ...policy, enabled: !policy.enabled });
            }, true)
          }
        >
          {policy?.enabled ? '关闭本机覆盖' : '开启本机覆盖'}
        </Button>
        <Button onClick={() => void action(() => desktopInvoke('restore_layout'), true)}>
          恢复布局
        </Button>
      </section>
      <section>
        <small>OBS</small>
        <strong>
          {obs?.connection === 'connected'
            ? '已连接'
            : obs?.connection === 'invalid_password'
              ? '凭据无效'
              : obs?.connection === 'password_required'
                ? '需要密码'
                : '未连接'}
        </strong>
        <span>{obs?.currentScene ?? '等待场景'}</span>
        <span>
          推流 {obs?.streaming ? '进行中' : '未启动'} · 录制 {obs?.recording ? '进行中' : '未启动'}
        </span>
        {obs?.video ? (
          <span>
            {obs.video.canvas} / {obs.video.output} · {obs.video.fps.toFixed(0)}fps
          </span>
        ) : null}
        <Button onClick={() => void action(() => obsCommand('open'))}>打开 OBS</Button>
        <Button
          onClick={() =>
            void action(async () => {
              const result = (await obsCommand('check')) as {
                findings: readonly { message: string }[];
              };
              setMessage(
                result.findings.length
                  ? result.findings
                      .slice(0, 3)
                      .map((item) => item.message)
                      .join('；')
                  : 'OBS 制播配置正常。',
              );
            })
          }
        >
          检查配置
        </Button>
        <Button
          onClick={() =>
            void action(async () => {
              const result = (await obsCommand('repair')) as {
                findings: readonly { message: string }[];
              };
              setMessage(
                result.findings.length
                  ? result.findings
                      .slice(0, 3)
                      .map((item) => item.message)
                      .join('；')
                  : 'OBS 制播配置已检查并修复。',
              );
            })
          }
        >
          一键修复
        </Button>
      </section>
      <section>
        <small>状态</small>
        <span>
          比赛数据{' '}
          {payload?.runtime.telemetryFreshness === 'fresh'
            ? '正常'
            : payload?.runtime.telemetryFreshness === 'stale'
              ? '已中断'
              : '等待输入'}
        </span>
        <span>
          Program{' '}
          {programState.state !== 'live'
            ? '未连接'
            : programState.current?.payload.status.telemetry === 'fresh'
              ? '正常'
              : programState.current?.payload.status.telemetry === 'stale'
                ? '已中断'
                : '等待数据'}
        </span>
        <span>OBS {obs?.connection === 'connected' ? '已连接' : '未连接'}</span>
        <Button onClick={() => void action(() => openTool('diagnostics'))}>运行诊断</Button>
      </section>
      <section>
        <small>制作</small>
        <Button
          disabled={!production || busy}
          onClick={() => production && void action(() => productionAction('hide', production))}
        >
          隐藏工作区
        </Button>
        <Button
          disabled={!production || busy}
          onClick={() => production && void action(() => productionAction('finish', production))}
        >
          结束制作
        </Button>
        <Button onClick={() => void action(() => openTool('hud'))}>HUD 编辑器</Button>
      </section>
      {message ? (
        <p className="workspace-message" role="status">
          {message}
        </p>
      ) : null}
    </main>
  );
}

export function WorkspacePreview() {
  return (
    <div className="workspace-preview">
      <WorkspaceLeft />
      <div className="workspace-preview__game">真实 CS2 窗口预留区域</div>
      <WorkspaceDock />
    </div>
  );
}
