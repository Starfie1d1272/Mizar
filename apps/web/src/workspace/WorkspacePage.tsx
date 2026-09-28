import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { PROGRAM_SCENES } from '@mizar/protocol/program-scenes';
import type { OperatorPayload } from '@mizar/protocol/operator';
import type { ProgramPayload } from '@mizar/protocol/program';
import { useBpSession } from '../bp/client';
import { useLocalChannelClient } from '../realtime';
import { Radar } from '../program/widgets/radar/Radar';
import { desktopInvoke, selectProgramScene, useProgramScenes } from './client';
import { workspaceCurrentPov, workspaceIssues, workspacePhase } from './model';
import { obsCommand, useObsStatus } from './obs-client';
import { LocalTournamentEditor, type LocalTournamentView } from './LocalTournamentEditor';
import { RivalHubLiveSourcePanel } from './RivalHubLiveSourcePanel';
import './workspace.css';

const PHASE_LABEL = {
  pre_match: '赛前',
  bp: 'BP',
  live: '赛中',
  map_end: '地图结束 / 图间',
  match_end: '比赛结束',
} as const;

function useLocalTournament() {
  const [view, setView] = useState<LocalTournamentView | null>(null);
  const refresh = useCallback(async () => {
    const response = await fetch('/local/v1/tournament', { cache: 'no-store' });
    if (response.ok) setView((await response.json()) as LocalTournamentView);
  }, []);
  useEffect(() => {
    queueMicrotask(() => void refresh());
    const timer = setInterval(() => void refresh(), 3000);
    return () => clearInterval(timer);
  }, [refresh]);
  return { view, refresh };
}

function LocalMatchControls({
  action,
}: {
  readonly action: (run: () => Promise<unknown>) => Promise<void>;
}) {
  const { view, refresh } = useLocalTournament();
  const [teamA, setTeamA] = useState('');
  const [teamB, setTeamB] = useState('');
  const [teamAId, setTeamAId] = useState('');
  const [teamBId, setTeamBId] = useState('');
  const [format, setFormat] = useState<'bo1' | 'bo3' | 'bo5'>('bo3');
  const [eventId, setEventId] = useState('');
  const selected = view?.matches.find((match) => match.matchId === view.activeLocalMatchId);
  return (
    <div className="workspace-local-match">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void action(async () => {
            const response = await fetch('/operator/local-match/create', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                teamA: teamA.trim(),
                teamB: teamB.trim(),
                ...(teamAId ? { teamAId } : {}),
                ...(teamBId ? { teamBId } : {}),
                format,
                ...(eventId ? { eventId } : {}),
              }),
            });
            if (!response.ok) throw new Error('本地比赛创建失败，请检查队名和赛制。');
            setTeamA('');
            setTeamB('');
            setTeamAId('');
            setTeamBId('');
            await refresh();
          });
        }}
      >
        <label>
          队伍 A
          <select value={teamAId} onChange={(event) => setTeamAId(event.target.value)}>
            <option value="">新队伍</option>
            {view?.teams.map((team) => (
              <option key={team.teamId} value={team.teamId}>
                {team.name}
              </option>
            ))}
          </select>
          <input
            value={
              teamAId ? (view?.teams.find((team) => team.teamId === teamAId)?.name ?? '') : teamA
            }
            disabled={!!teamAId}
            onChange={(event) => setTeamA(event.target.value)}
          />
        </label>
        <label>
          队伍 B
          <select value={teamBId} onChange={(event) => setTeamBId(event.target.value)}>
            <option value="">新队伍</option>
            {view?.teams.map((team) => (
              <option key={team.teamId} value={team.teamId}>
                {team.name}
              </option>
            ))}
          </select>
          <input
            value={
              teamBId ? (view?.teams.find((team) => team.teamId === teamBId)?.name ?? '') : teamB
            }
            disabled={!!teamBId}
            onChange={(event) => setTeamB(event.target.value)}
          />
        </label>
        <label>
          赛制{' '}
          <select
            value={format}
            onChange={(event) => setFormat(event.target.value as typeof format)}
          >
            <option value="bo1">BO1</option>
            <option value="bo3">BO3</option>
            <option value="bo5">BO5</option>
          </select>
        </label>
        <label>
          赛事{' '}
          <select value={eventId} onChange={(event) => setEventId(event.target.value)}>
            <option value="">新建本地赛事</option>
            {view?.events.map((item) => (
              <option key={item.eventId} value={item.eventId}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
        <button
          disabled={
            (!teamAId && !teamA.trim()) ||
            (!teamBId && !teamB.trim()) ||
            (!!teamAId && teamAId === teamBId)
          }
        >
          创建本地比赛
        </button>
      </form>
      {view?.matches.length ? (
        <label>
          本地比赛{' '}
          <select
            value={selected?.matchId ?? ''}
            onChange={(event) => {
              void action(async () => {
                const response = await fetch('/operator/local-match/select', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ matchId: event.target.value }),
                });
                if (!response.ok) throw new Error('切换本地比赛失败。');
                await refresh();
              });
            }}
          >
            <option value="">选择比赛</option>
            {view.matches.map((match) => (
              <option key={match.matchId} value={match.matchId}>
                {match.entrants.a.name} vs {match.entrants.b.name} · {match.format.toUpperCase()}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <LocalTournamentEditor
        key={`${view?.selectedMatchId ?? ''}:${view?.contextRevision ?? ''}`}
        view={view}
        refresh={refresh}
        action={action}
      />
    </div>
  );
}

function StateLine({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="workspace-state">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

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
        {phase === 'pre_match' || phase === 'bp' ? <a href="/operator/bp">打开 BP 制作</a> : null}
      </section>
      <section aria-label="制作状态">
        <small>制作状态</small>
        <StateLine
          label="比赛数据"
          value={
            operator?.runtime.telemetryFreshness === 'fresh'
              ? '正常'
              : operator?.runtime.telemetryFreshness === 'stale'
                ? '已中断'
                : '等待输入'
          }
        />
        <StateLine
          label="比赛绑定"
          value={
            operator?.matchContext.freshness === 'fresh'
              ? '已绑定'
              : operator?.matchContext.freshness === 'stale'
                ? '使用缓存'
                : '未绑定'
          }
        />
        <StateLine
          label="选手识别"
          value={
            operator?.identity.state === 'matched'
              ? '已匹配'
              : operator?.identity.state === 'mismatch'
                ? '不一致'
                : '待核对'
          }
        />
        <StateLine
          label="播出画面"
          value={
            program?.status.telemetry === 'fresh' && program.status.identity !== 'mismatch'
              ? '正常'
              : program?.status.telemetry === 'stale'
                ? '已中断'
                : '等待数据'
          }
        />
        <StateLine
          label="OBS"
          value={
            obs?.connection === 'connected'
              ? obs.sceneAligned === false
                ? '场景待核对'
                : obs.findings.length
                  ? '配置需检查'
                  : '已连接'
              : '未连接'
          }
        />
        <StateLine
          label="事件增强"
          value={
            operator?.sources.cstvProgram.state === 'live' &&
            operator.sources.cstvProgram.lastEventTick !== null
              ? '可用'
              : operator?.sources.cstvProgram.state === 'disabled'
                ? '未启用'
                : '等待事件'
          }
        />
        <StateLine label="观察辅助" value="未启用" />
      </section>
      {issues.length ? (
        <section className="workspace-issues" aria-label="需要处理">
          <small>需要处理</small>
          {issues.slice(0, 3).map((issue) => (
            <p key={issue}>{issue}</p>
          ))}
          {issues.length > 3 ? <p>另有 {issues.length - 3} 项问题</p> : null}
          <a href="/debug">打开运行诊断</a>
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
    <main className="workspace-left">
      <div className="workspace-radar">
        <Radar client={radar} zoomMode="auto" />
      </div>
      <ContextPanel
        operator={state.state === 'live' ? (state.current?.payload ?? null) : null}
        program={programState.state === 'live' ? (programState.current?.payload ?? null) : null}
      />
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
  const [overlayEnabled, setOverlayEnabled] = useState(true);
  const [obsPassword, setObsPassword] = useState('');
  const [obsPort, setObsPort] = useState(4455);
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
    <main className="workspace-dock" aria-label="现场控制底栏">
      <section>
        <small>场景</small>
        <div className="workspace-scene-buttons">
          {PROGRAM_SCENES.map((scene) => (
            <button
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
            </button>
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
        <a href="/operator/bp">BP 制作</a>
        <LocalMatchControls action={action} />
        <RivalHubLiveSourcePanel
          action={action}
          onMessage={setMessage}
          currentMatchTitle={
            payload?.matchContext.summary
              ? `${payload.matchContext.summary.entryAName} vs ${payload.matchContext.summary.entryBName}`
              : null
          }
        />
      </section>
      <section>
        <small>本机</small>
        <button
          onClick={() =>
            void action(async () => {
              const enabled = !overlayEnabled;
              await desktopInvoke('set_program_overlay_enabled', { enabled });
              setOverlayEnabled(enabled);
            }, true)
          }
        >
          Program HUD {overlayEnabled ? '关' : '开'}
        </button>
        <button onClick={() => void action(() => desktopInvoke('restore_layout'), true)}>
          恢复布局
        </button>
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
        <button onClick={() => void action(() => obsCommand('open'))}>打开 OBS</button>
        {window.__TAURI_INTERNALS__ ? (
          <button
            onClick={() =>
              void action(async () => {
                const path = await desktopInvoke<string | null>('select_obs_executable');
                if (path) await obsCommand('configure', { executablePath: path });
              })
            }
          >
            选择 OBS 程序
          </button>
        ) : null}
        <button
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
        </button>
        <button
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
        </button>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void action(async () => {
              await obsCommand('configure', { password: obsPassword, port: obsPort });
              setObsPassword('');
            });
          }}
        >
          <label>
            WebSocket 端口{' '}
            <input
              type="number"
              min="1"
              max="65535"
              value={obsPort}
              onChange={(event) => setObsPort(Number(event.target.value))}
            />
          </label>
          <label>
            WebSocket 密码{' '}
            <input
              type="password"
              autoComplete="off"
              value={obsPassword}
              onChange={(event) => setObsPassword(event.target.value)}
            />
          </label>
          <button>保存连接设置</button>
        </form>
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
        <a href="/debug">运行诊断</a>
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
