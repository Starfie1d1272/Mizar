import { AutomaticPreparation } from './AutomaticPreparation';
import { DemoTestPanel } from './DemoTestPanel';
import { matchRound } from './match-presentation';
import { ProductionStatus } from '../workspace/ProductionStatus';
import type { ContextEnvelope } from '@mizar/core/match-context';
import type { MatchDocumentV1 } from '@mizar/protocol/context';
import type { ProductionGuidance } from '@mizar/protocol/program-scenes';
import { MatchDocumentView, type MatchSection } from './MatchDocumentView';
import { useEffect, useState } from 'react';
import { HUD_WIDGET_REGISTRY } from '@mizar/hud-config';
import { OperatorShell } from '../operator/OperatorShell';
import { RivalHubPreparationPanel } from '../operator/RivalHubPreparationPanel';
import { RivalHubSyncControls } from '../operator/RivalHubSyncControls';
import { useHudConfigClient } from '../realtime/hud-config-client';
import { desktopInvoke, useProgramScenes } from '../workspace/client';
import { LocalTournamentEditor } from '../workspace/LocalTournamentEditor';
import { Button, Panel, StatusBanner, StatusPill } from '../ui';
import { LocalOverlayControls } from './LocalOverlayControls';
import { LocalMatchControls } from './LocalMatchControls';
import { useLocalTournament } from './tournament';
import { command, openTool, productionAction, useLocalRead, type Production } from './client';
import { RosterCapture, type RosterCandidate } from './RosterCapture';
import { Settings } from './Settings';
import { ProgramPreview } from './ProgramPreview';
import { SpectatorHudCommands } from './SpectatorHudCommands';
import { Cs2Recovery } from './Cs2Recovery';
import { SpectatorWorkflow } from './SpectatorWorkflow';
import './preparation.css';

const tabs = {
  '/matches': [
    ['details', '比赛资料'],
    ['roster', '队伍与名单'],
    ['maps', '地图与 BP'],
  ],
  '/picture': [
    ['program', '节目'],
    ['hud', 'HUD'],
    ['overlay', '本机 HUD'],
  ],
  '/settings': [
    ['gsi', 'CS2 与 GSI'],
    ['obs', 'OBS'],
    ['rivalhub', 'RivalHub'],
    ['advanced', '高级'],
  ],
} as const;

export interface RivalsRehearsalView {
  loaded: boolean;
  focusMatchId: string | null;
  selectedMatchId: string | null;
  stageIndex: number;
  stages: { label: string; scene: string }[];
  provenance: {
    competitionSource: string;
    capturedAt: string;
    gameplaySource: string;
    gameplayRelationship: string;
    missingLogoEntryId: string | null;
  } | null;
}

function TeamBadge({ name, logoUrl }: { readonly name: string; readonly logoUrl: string | null }) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  return (
    <span className="preparation-team-badge" aria-hidden="true">
      {logoUrl && logoUrl !== failedUrl ? (
        <img src={logoUrl} alt="" onError={() => setFailedUrl(logoUrl)} />
      ) : (
        name.slice(0, 1)
      )}
    </span>
  );
}

export function PreparationPage() {
  const path = window.location.pathname === '/operator' ? '/' : window.location.pathname;
  const options = tabs[path as keyof typeof tabs];
  const requestedTab = new URLSearchParams(window.location.search).get('tab');
  const createFromServer =
    new URLSearchParams(window.location.search).get('createFromServer') === '1';
  const openMatchSelection =
    new URLSearchParams(window.location.search).has('select') ||
    new URLSearchParams(window.location.search).has('createLocal');
  const tab =
    (path === '/matches' && createFromServer ? 'roster' : undefined) ??
    options?.find(([key]) => key === requestedTab)?.[0] ??
    options?.[0][0] ??
    '';
  const envelope = useLocalRead<ContextEnvelope<MatchDocumentV1>>('/local/v1/match-document');
  const match = envelope?.document;
  const matchGuidance = useLocalRead<ProductionGuidance>(
    path === '/matches' && (envelope?.source === 'rivalhub' || envelope?.source === 'cache')
      ? '/local/v1/production-guidance'
      : null,
    5000,
  );
  const { view, refresh } = useLocalTournament();
  const local = envelope?.source === 'local' && view?.activeLocalMatchId === match?.matchId;
  const scenes = useProgramScenes();
  const hud = useHudConfigClient();
  const production = useLocalRead<Production>('/local/v1/production');
  const rivalhub = useLocalRead<{ paired: boolean; displayName?: string | null }>(
    '/local/v1/rivalhub-connection',
  );
  const rehearsal = useLocalRead<RivalsRehearsalView>(
    import.meta.env.DEV || import.meta.env.VITE_QUALIFICATION === '1'
      ? '/local/v1/rivals-rehearsal'
      : null,
  );

  const hasSampleCapability =
    (import.meta.env.DEV || import.meta.env.VITE_QUALIFICATION === '1') && rehearsal !== null;
  const rehearsalSchedule = useLocalRead<{
    competition: { name: string };
    matches: {
      matchId: string;
      scheduledAt: string | null;
      entrantA: { name: string };
      entrantB: { name: string };
      format: string;
      stageLabel?: string | null;
    }[];
  }>(
    envelope?.source === 'fixture' && rehearsal?.loaded
      ? '/local/v1/rivals-rehearsal/schedule'
      : null,
  );

  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  async function action(run: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    setMessage('');
    try {
      await run();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '操作未完成。');
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    const enter = () => {
      void fetch('/local/v1/production', { cache: 'no-store' })
        .then((response) => response.json() as Promise<Production>)
        .then((current) => productionAction('enter', current))
        .catch((error: Error) => setMessage(error.message));
    };
    window.addEventListener('mizar-enter', enter);
    return () => window.removeEventListener('mizar-enter', enter);
  }, []);

  const tools = (
    <div className="preparation-actions">
      {(
        [
          ['hud', 'HUD 编辑器'],
          ['bp', 'BP 工作台'],
          ['preview', '节目预览'],
          ['diagnostics', '运行诊断'],
        ] as const
      ).map(([tool, label]) => (
        <Button key={tool} onClick={() => void action(() => openTool(tool))}>
          {label}
        </Button>
      ))}
    </div>
  );

  const capabilities =
    useLocalRead<
      { label: string; ready: boolean; reason: string; href: string; action: string | null }[]
    >('/local/v1/readiness');

  const problems = (capabilities ?? []).filter((item) => !item.ready && item.action);
  const pending = (capabilities ?? []).filter((item) => !item.ready && !item.action);
  const completed = (capabilities ?? []).filter((item) => item.ready);
  const settingsTitle: Record<string, string> = {
    gsi: '游戏设置',
    obs: 'OBS 连接',
    rivalhub: '赛事平台',
    advanced: '高级设置',
  };

  return (
    <OperatorShell active={path}>
      <main className="preparation" data-page={path}>
        <AutomaticPreparation />
        <header className="preparation-heading">
          <div>
            <h1>
              {path === '/matches'
                ? '比赛资料'
                : path === '/picture'
                  ? '播出画面'
                  : path === '/settings'
                    ? (settingsTitle[tab] ?? '设置')
                    : '总览'}
            </h1>
          </div>
          <Button
            variant="primary"
            disabled={busy || !production?.canEnter}
            onClick={() => production && void action(() => productionAction('enter', production))}
          >
            {production?.mode === 'hidden' || production?.mode === 'live'
              ? '打开直播工作台'
              : window.__TAURI_INTERNALS__
                ? '启动游戏并打开工作台'
                : '打开直播工作台'}
          </Button>
        </header>

        {!(path === '/settings' && tab === 'gsi') ? <Cs2Recovery production={production} /> : null}
        {message ? <StatusBanner tone="danger">{message}</StatusBanner> : null}
        {options && path !== '/settings' ? (
          <nav className="preparation-tabs" aria-label="页面分区">
            {options.map(([key, label]) => (
              <a
                key={key}
                href={`${path}?tab=${key}`}
                aria-current={key === tab ? 'page' : undefined}
              >
                {label}
              </a>
            ))}
          </nav>
        ) : null}

        {path === '/' ? (
          <div className="preparation-dashboard" data-selected={Boolean(match)}>
            <DemoTestPanel />
            {!match ? (
              <Panel className="preparation-task-panel">
                <div className="preparation-task-content">
                  <div className="preparation-task-header">
                    <div>
                      <h2>选择比赛</h2>
                      <p>选择已有比赛，或新建本地比赛。</p>
                    </div>
                  </div>
                  <div className="preparation-actions">
                    {rivalhub?.paired ? (
                      <Button
                        variant="secondary"
                        onClick={() => {
                          window.location.href = '/matches?select=1';
                        }}
                      >
                        从 RivalHub 选择比赛
                      </Button>
                    ) : (
                      <Button
                        variant="secondary"
                        onClick={() => {
                          window.location.href = '/settings?tab=rivalhub';
                        }}
                      >
                        连接 RivalHub
                      </Button>
                    )}
                    <CurrentServerMatchEntry />
                    <Button
                      variant="primary"
                      onClick={() => {
                        window.location.href = '/matches?createLocal=1#local-match';
                      }}
                    >
                      新建本地比赛
                    </Button>
                  </div>
                  {hasSampleCapability ? (
                    <details className="preparation-sample-entry">
                      <summary>体验示例</summary>
                      <Button
                        variant="secondary"
                        disabled={busy}
                        onClick={() =>
                          void action(async () => {
                            await command('/operator/rivals-rehearsal/load');
                            window.location.reload();
                          })
                        }
                      >
                        加载示例比赛
                      </Button>
                    </details>
                  ) : null}
                </div>
                <div className="preparation-task-art" aria-hidden="true">
                  <img src="/brand/mizar-mark.svg" alt="" />
                </div>
              </Panel>
            ) : (
              <Panel className="preparation-match">
                <div className="preparation-match__meta">
                  <span>
                    {match.competition?.name} · {match.format.toUpperCase()}
                  </span>
                  <StatusPill tone="info">
                    {envelope?.source === 'fixture'
                      ? '示例比赛'
                      : envelope?.source === 'local'
                        ? '本地比赛'
                        : 'RivalHub'}
                    {envelope?.freshness === 'stale' ? ' · 缓存资料' : ''}
                  </StatusPill>
                </div>
                <h2 className="preparation-match__teams">
                  <span className="preparation-match__team">
                    <TeamBadge name={match.entrants.a.name} logoUrl={match.entrants.a.logoUrl} />
                    <strong title={match.entrants.a.name}>{match.entrants.a.name}</strong>
                  </span>
                  <span className="preparation-match__versus">
                    VS · {match.format.toUpperCase()}
                  </span>
                  <span className="preparation-match__team">
                    <TeamBadge name={match.entrants.b.name} logoUrl={match.entrants.b.logoUrl} />
                    <strong title={match.entrants.b.name}>{match.entrants.b.name}</strong>
                  </span>
                </h2>
                <p>
                  {[
                    match.stageLabel,
                    matchRound(match),
                    match.matchLabel,
                    match.scheduledAt
                      ? new Date(match.scheduledAt).toLocaleString('zh-CN', {
                          timeZone: 'Asia/Shanghai',
                          hour12: false,
                        })
                      : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </p>
                <div className="preparation-match__summary">
                  <span>BP · {match.veto.length > 0 ? `${match.veto.length} 步` : '暂无记录'}</span>
                  <span>
                    名单 · 首发 {match.entrants.a.players.filter((p) => p.isStarter).length} /{' '}
                    {match.entrants.b.players.filter((p) => p.isStarter).length} 人
                  </span>
                  <span>
                    地图 · 已确定 {match.maps.length} 图（
                    {match.maps.map((m) => m.mapName.replace(/^de_/, '')).join(' · ')}）
                  </span>
                </div>
                <div className="preparation-actions">
                  <Button
                    variant="secondary"
                    onClick={() => {
                      window.location.href = '/matches';
                    }}
                  >
                    查看比赛资料
                  </Button>
                  <Button
                    variant="secondary"
                    onClick={() => {
                      window.location.href = '/matches?select=1';
                    }}
                  >
                    切换比赛
                  </Button>
                  {hasSampleCapability && envelope?.source === 'fixture' ? (
                    <Button
                      variant="secondary"
                      disabled={busy}
                      onClick={() =>
                        void action(async () => {
                          await command('/operator/rivals-rehearsal/stop');
                          window.location.reload();
                        })
                      }
                    >
                      退出示例
                    </Button>
                  ) : null}
                </div>
              </Panel>
            )}

            <SpectatorWorkflow capabilities={capabilities} production={production} />
            {match ? (
              <div className="preparation-overview">
                <Panel>
                  <div className="preparation-check-heading">
                    <h2>开播检查</h2>
                    <StatusPill
                      tone={
                        capabilities === null
                          ? 'info'
                          : problems.length
                            ? 'warning'
                            : pending.length
                              ? 'info'
                              : 'success'
                      }
                    >
                      {capabilities === null
                        ? '读取中'
                        : problems.length
                          ? `${problems.length} 项待处理`
                          : pending.length
                            ? '待确认'
                            : '已就绪'}
                    </StatusPill>
                  </div>
                  {completed.length ? (
                    <div className="preparation-completed" aria-label="已完成检查">
                      {completed.map(({ label }) => (
                        <span key={label}>
                          <span aria-hidden="true">✓ </span>
                          {label === '比赛上下文' ? '比赛资料' : label}
                        </span>
                      ))}
                    </div>
                  ) : null}
                  {problems.map(({ label, reason, href, action: nextAction }) => (
                    <a
                      className="preparation-readiness"
                      data-tone="warning"
                      key={label}
                      href={href}
                      aria-label={nextAction ?? `检查 ${label}`}
                    >
                      <svg
                        aria-hidden="true"
                        className="preparation-check-icon"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                      >
                        <circle cx="12" cy="12" r="9" />
                        <path d="M12 7v6" />
                        <circle cx="12" cy="17" r="0.75" fill="currentColor" stroke="none" />
                      </svg>
                      <div>
                        <strong>{label === '比赛上下文' ? '比赛资料' : label}</strong>
                        <p>{reason}</p>
                      </div>
                      <span className="mizar-button">{label === 'OBS' ? '配置' : '检查'}</span>
                    </a>
                  ))}
                  {pending.length ? (
                    <details className="preparation-pending">
                      <summary>待确认 · {pending.length} 项</summary>
                      {pending.map(({ label, reason, href }) => (
                        <a key={label} href={href}>
                          <strong>{label}</strong>
                          <span>{reason}</span>
                        </a>
                      ))}
                    </details>
                  ) : null}
                </Panel>
              </div>
            ) : null}
            <div className="preparation-tool-strip">
              <span>常用工具</span>
              {tools}
            </div>
            {match && production && production.mode !== 'preparation' ? (
              <ProductionStatus matchId={match.matchId} />
            ) : null}
            {hasSampleCapability && rehearsal?.loaded && envelope?.source === 'fixture' ? (
              <details className="preparation-rehearsal-stage">
                <summary>示例体验</summary>
                <div className="preparation-task-header">
                  <div>
                    {rehearsal.selectedMatchId === rehearsal.focusMatchId ? (
                      <p>当前阶段：{rehearsal.stages[rehearsal.stageIndex]?.label ?? '赛前等待'}</p>
                    ) : (
                      <p>返回初始示例比赛后，可切换阶段。</p>
                    )}
                  </div>
                </div>
                {envelope?.source === 'fixture' &&
                rehearsal?.loaded &&
                rehearsalSchedule?.matches ? (
                  <div className="preparation-schedule-selector">
                    <label htmlFor="rehearsal-match-select">切换示例比赛：</label>
                    <select
                      id="rehearsal-match-select"
                      value={rehearsal.selectedMatchId ?? ''}
                      disabled={busy}
                      onChange={(e) => {
                        const matchId = e.target.value;
                        void action(async () => {
                          await command('/operator/rivals-rehearsal/select', { matchId });
                          window.location.reload();
                        });
                      }}
                    >
                      {rehearsalSchedule.matches.map((m) => (
                        <option key={m.matchId} value={m.matchId}>
                          {m.matchId === rehearsal.focusMatchId ? '初始示例 · ' : ''}
                          {m.entrantA.name} vs {m.entrantB.name} · {m.format.toUpperCase()}
                          {m.stageLabel ? ` (${m.stageLabel})` : ''}
                        </option>
                      ))}
                    </select>
                  </div>
                ) : null}
                {rehearsal.selectedMatchId === rehearsal.focusMatchId ? (
                  <div className="preparation-rehearsal-stage-buttons">
                    {rehearsal.stages.map((stage, idx) => (
                      <Button
                        key={stage.label}
                        aria-pressed={rehearsal.stageIndex === idx}
                        variant={rehearsal.stageIndex === idx ? 'primary' : 'secondary'}
                        disabled={busy}
                        onClick={() =>
                          void action(async () => {
                            await command('/operator/rivals-rehearsal/stage', { index: idx });
                          })
                        }
                      >
                        {stage.label}
                      </Button>
                    ))}
                  </div>
                ) : null}
              </details>
            ) : null}
          </div>
        ) : path === '/matches' ? (
          <>
            <RivalHubSyncControls />
            <details
              className="preparation-switch"
              open={!match || createFromServer || openMatchSelection}
            >
              <summary>切换比赛</summary>
              {!match ? (
                <RosterCapture create autoOpen={createFromServer} onSaved={() => void refresh()} />
              ) : null}
              {hasSampleCapability && rehearsal?.loaded && rehearsalSchedule?.matches ? (
                <>
                  <h2>{rehearsalSchedule.competition.name} · 示例赛程</h2>
                  <div className="preparation-schedule-selector">
                    <label htmlFor="rehearsal-match-select-tab">切换示例比赛：</label>
                    <select
                      id="rehearsal-match-select-tab"
                      value={rehearsal.selectedMatchId ?? ''}
                      disabled={busy}
                      onChange={(e) => {
                        const matchId = e.target.value;
                        void action(async () => {
                          await command('/operator/rivals-rehearsal/select', { matchId });
                          window.location.reload();
                        });
                      }}
                    >
                      {rehearsalSchedule.matches.map((m) => (
                        <option key={m.matchId} value={m.matchId}>
                          {m.matchId === rehearsal.focusMatchId ? '初始示例 · ' : ''}
                          {m.entrantA.name} vs {m.entrantB.name} · {m.format.toUpperCase()}
                          {m.stageLabel ? ` (${m.stageLabel})` : ''}
                        </option>
                      ))}
                    </select>
                  </div>
                </>
              ) : null}
              <h2 id="local-match">本地比赛</h2>
              <LocalMatchControls action={action} />
              <h2>RivalHub</h2>
              <RivalHubPreparationPanel mode="matches" />
            </details>
            {match && local ? (
              <>
                {tab === 'roster' ? (
                  <RosterCapture
                    names={{ a: match.entrants.a.name, b: match.entrants.b.name }}
                    onSaved={() => void refresh()}
                  />
                ) : null}
                <LocalTournamentEditor
                  document={match}
                  section={tab as MatchSection}
                  view={view}
                  refresh={refresh}
                  action={action}
                />
              </>
            ) : match ? (
              <>
                <div className="preparation-match__meta">
                  <span>
                    {envelope?.source === 'local'
                      ? '正在读取本地编辑状态。'
                      : envelope?.source === 'fixture'
                        ? 'RivalHub 赛事快照 · 示例比赛'
                        : 'RivalHub 比赛资料'}
                  </span>
                  {matchGuidance?.matchId === match.matchId &&
                  matchGuidance.rivalhubUrl &&
                  envelope?.source !== 'fixture' ? (
                    <a
                      href={matchGuidance.rivalhubUrl}
                      target="_blank"
                      rel="noreferrer"
                      onClick={(event) => {
                        if (!window.__TAURI_INTERNALS__) return;
                        event.preventDefault();
                        void action(() =>
                          desktopInvoke('open_rivalhub_workbench', {
                            url: matchGuidance.rivalhubUrl,
                          }),
                        );
                      }}
                    >
                      在网站管理
                    </a>
                  ) : null}
                </div>
                {tab !== 'maps' ? (
                  <MatchDocumentView document={match} section={tab as MatchSection} />
                ) : null}
              </>
            ) : null}
            {tab === 'maps' && match ? (
              <>
                <MatchDocumentView document={match} section="maps" />
                <Panel>
                  <h2>BP 制作</h2>
                  <p>
                    {scenes?.available.includes('bp')
                      ? 'BP 已就绪'
                      : (scenes?.blocked.bp ?? '等待 BP 数据')}
                  </p>
                  <Button onClick={() => void action(() => openTool('bp'))}>打开 BP 工作台</Button>
                </Panel>
              </>
            ) : null}
          </>
        ) : path === '/picture' ? (
          tab === 'program' ? (
            <>
              <ProgramPreview />
            </>
          ) : tab === 'hud' ? (
            <Panel>
              <h2>{hud.current.preset.name}</h2>
              <p>布局 · {hud.current.layout.name}</p>
              <p>外观 · {hud.current.theme.name}</p>
              <p>
                {HUD_WIDGET_REGISTRY.filter(
                  (widget) =>
                    hud.current.layout.widgets[widget.id].visible &&
                    widget.rendererAvailability === 'implemented',
                )
                  .map((widget) => widget.label)
                  .join(' · ')}
              </p>
              <Button onClick={() => void action(() => openTool('hud'))}>打开 HUD 编辑器</Button>
            </Panel>
          ) : (
            <div className="preparation-overlay-workspace">
              <Panel className="preparation-overlay-display">
                <header>
                  <h2>本机 HUD</h2>
                  <p>仅影响本机显示，OBS 播出不变。其他 HUD 跟随当前预设。</p>
                </header>
                <LocalOverlayControls />
              </Panel>
              <Panel>
                <SpectatorHudCommands />
              </Panel>
            </div>
          )
        ) : (
          <Settings tab={tab} />
        )}
      </main>
    </OperatorShell>
  );
}

function CurrentServerMatchEntry() {
  const result = useLocalRead<{ candidate: RosterCandidate | null }>('/local/v1/roster-candidate');
  return result?.candidate ? (
    <Button
      variant="secondary"
      onClick={() => {
        window.location.href = '/matches?tab=roster&createFromServer=1';
      }}
    >
      从当前服务器创建比赛
    </Button>
  ) : null;
}
