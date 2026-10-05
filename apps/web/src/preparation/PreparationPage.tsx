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
import { useHudConfigClient } from '../realtime/hud-config-client';
import { desktopInvoke, useProgramScenes } from '../workspace/client';
import { LocalTournamentEditor } from '../workspace/LocalTournamentEditor';
import { Button, Panel, Select, StatusBanner, StatusPill } from '../ui';
import { LocalMatchControls } from './LocalMatchControls';
import { useLocalTournament } from './tournament';
import { command, openTool, productionAction, useLocalRead, type Production } from './client';
import { RosterCapture, type RosterCandidate } from './RosterCapture';
import { Settings } from './Settings';
import { ProgramPreview } from './ProgramPreview';
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
    ['overlay', '本机覆盖'],
  ],
  '/settings': [
    ['gsi', 'CS2 与 GSI'],
    ['obs', 'OBS'],
    ['rivalhub', 'RivalHub'],
    ['advanced', '高级'],
  ],
} as const;

export interface OverlayPolicy {
  revision: string;
  enabled: boolean;
  visibility: Record<string, boolean>;
}

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

export function PreparationPage() {
  const path = window.location.pathname === '/operator' ? '/' : window.location.pathname;
  const options = tabs[path as keyof typeof tabs];
  const requestedTab = new URLSearchParams(window.location.search).get('tab');
  const createFromServer =
    new URLSearchParams(window.location.search).get('createFromServer') === '1';
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
  const policy = useLocalRead<OverlayPolicy>('/local/v1/desktop-overlay');
  const rivalhub = useLocalRead<{ paired: boolean; displayName?: string | null }>(
    '/local/v1/rivalhub-connection',
  );
  const rehearsal = useLocalRead<RivalsRehearsalView>('/local/v1/rivals-rehearsal');

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

  const readiness = [
    ...(capabilities ?? []).map(
      (item) => [item.label, item.ready, item.reason, item.href] as const,
    ),
    ['RivalHub', rivalhub?.paired === true, '独立模式', '/settings?tab=rivalhub'],
  ] as const;

  const attention = (capabilities ?? []).filter((item) => item.action);

  return (
    <OperatorShell active={path}>
      <main className="preparation" data-page={path}>
        <header className="preparation-heading">
          <div>
            <p>
              {path === '/matches'
                ? '核对比赛、名单与地图'
                : path === '/picture'
                  ? '预览播出效果，调整画面'
                  : path === '/settings'
                    ? '连接游戏、OBS 与赛事平台'
                    : '检查准备情况，开始制作'}
            </p>
            <h1>
              {path === '/matches'
                ? '比赛'
                : path === '/picture'
                  ? '画面'
                  : path === '/settings'
                    ? '设置'
                    : '总览'}
            </h1>
          </div>
          <Button
            variant="primary"
            disabled={busy || !production?.canEnter}
            onClick={() => production && void action(() => productionAction('enter', production))}
          >
            {production?.mode === 'hidden' || production?.mode === 'live' ? '恢复现场' : '进入现场'}
          </Button>
        </header>

        {message ? <StatusBanner tone="danger">{message}</StatusBanner> : null}
        {path === '/settings' &&
        tab === 'obs' &&
        new URLSearchParams(window.location.search).has('prepare') ? (
          <StatusBanner tone="warning">
            现场尚未打开。请先完成 OBS 连接与场景检查，再进入现场。
          </StatusBanner>
        ) : null}

        {options ? (
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
          <>
            {!match ? (
              <Panel className="preparation-task-panel">
                <div className="preparation-task-header">
                  <div>
                    <h2>选择下一场比赛</h2>
                    <p>选择赛事平台已排期的比赛，或从当前服务器、本地配置开始制作。</p>
                  </div>
                </div>
                <div className="preparation-actions">
                  {rivalhub?.paired ? (
                    <Button
                      variant="primary"
                      onClick={() => {
                        window.location.href = '/matches';
                      }}
                    >
                      从 RivalHub 选择比赛
                    </Button>
                  ) : (
                    <Button
                      variant="primary"
                      onClick={() => {
                        window.location.href = '/settings?tab=rivalhub';
                      }}
                    >
                      连接 RivalHub
                    </Button>
                  )}
                  <CurrentServerMatchEntry />
                  <Button
                    variant="secondary"
                    onClick={() => {
                      window.location.href = '/matches';
                    }}
                  >
                    新建本地比赛
                  </Button>
                  {hasSampleCapability ? (
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
                      加载 Rivals 示例
                    </Button>
                  ) : null}
                </div>
              </Panel>
            ) : (
              <Panel className="preparation-match">
                <div className="preparation-match__meta">
                  <span>
                    {match.competition.name} · {match.format.toUpperCase()}
                  </span>
                  <StatusPill tone="info">
                    {envelope?.source === 'fixture'
                      ? '开发示例'
                      : envelope?.source === 'local'
                        ? '本地比赛'
                        : 'RivalHub'}
                    {envelope?.freshness === 'stale' ? ' · 缓存资料' : ''}
                  </StatusPill>
                </div>
                <h2>
                  {match.entrants.a.name}
                  <span>vs</span>
                  {match.entrants.b.name}
                </h2>
                <p>
                  {[
                    match.stageLabel,
                    matchRound(match),
                    match.matchLabel,
                    match.scheduledAt ? new Date(match.scheduledAt).toLocaleString('zh-CN') : null,
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
                          {m.matchId === rehearsal.focusMatchId ? '★ [焦点比赛] ' : ''}
                          {m.entrantA.name} vs {m.entrantB.name} · {m.format.toUpperCase()}
                          {m.stageLabel ? ` (${m.stageLabel})` : ''}
                        </option>
                      ))}
                    </select>
                  </div>
                ) : null}
                <div className="preparation-actions">
                  <Button
                    variant="primary"
                    onClick={() => {
                      window.location.href = '/matches';
                    }}
                  >
                    查看比赛资料
                  </Button>
                  <Button
                    variant="secondary"
                    onClick={() => {
                      window.location.href = '/matches';
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

            {hasSampleCapability && rehearsal?.loaded && envelope?.source === 'fixture' ? (
              <details className="preparation-rehearsal-stage">
                <summary>演练控制</summary>
                <div className="preparation-task-header">
                  <div>
                    {rehearsal.selectedMatchId === rehearsal.focusMatchId ? (
                      <p>当前阶段：{rehearsal.stages[rehearsal.stageIndex]?.label ?? '赛前等待'}</p>
                    ) : (
                      <p>当前为赛程前后比赛预览；切换回焦点比赛可继续推进 15 个示例阶段。</p>
                    )}
                  </div>
                </div>
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

            <ProductionStatus matchId={match?.matchId ?? null} />
            <div className="preparation-overview">
              <Panel>
                <h2>开播检查</h2>
                {readiness.map(([label, ready, reason, href]) => (
                  <a className="preparation-readiness" key={label} href={href}>
                    <span>{label === '比赛上下文' ? '比赛资料' : label}</span>
                    <span>{ready ? '已就绪' : reason}</span>
                  </a>
                ))}
              </Panel>
              <div>
                <Panel>
                  <h2>需要关注</h2>
                  {capabilities === null ? (
                    <p>正在读取制作状态。</p>
                  ) : attention.length === 0 ? (
                    <p>暂无需要处理的问题。</p>
                  ) : null}
                  {attention.map(({ label, action: actText, href }) => (
                    <a className="preparation-attention" key={label} href={href}>
                      <strong>{actText} →</strong>
                    </a>
                  ))}
                </Panel>
                <Panel>
                  <h2>常用工具</h2>
                  {tools}
                </Panel>
              </div>
            </div>
          </>
        ) : path === '/matches' ? (
          <>
            <details className="preparation-switch" open={!match}>
              <summary>切换比赛</summary>
              {!match ? (
                <RosterCapture create autoOpen={createFromServer} onSaved={() => void refresh()} />
              ) : null}
              {hasSampleCapability && rehearsal?.loaded && rehearsalSchedule?.matches ? (
                <>
                  <h2>Rivals 示例赛程</h2>
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
                          {m.matchId === rehearsal.focusMatchId ? '★ [焦点比赛] ' : ''}
                          {m.entrantA.name} vs {m.entrantB.name} · {m.format.toUpperCase()}
                          {m.stageLabel ? ` (${m.stageLabel})` : ''}
                        </option>
                      ))}
                    </select>
                  </div>
                </>
              ) : null}
              <h2>本地比赛</h2>
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
                        ? 'RivalHub 赛事快照 · 演练中'
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
            <Panel>
              <h2>本机覆盖</h2>
              <p>
                与播出画面共享当前 HUD 预设，以下显隐只影响本机 CS2
                上方的覆盖画面。工作区大雷达始终独立。
              </p>
              <Button
                disabled={!policy || busy}
                onClick={() =>
                  policy &&
                  void action(() =>
                    command('/operator/desktop-overlay', { ...policy, enabled: !policy.enabled }),
                  )
                }
              >
                {policy?.enabled ? '关闭本机覆盖' : '开启本机覆盖'}
              </Button>
              {HUD_WIDGET_REGISTRY.filter(
                (widget) => widget.rendererAvailability === 'implemented',
              ).map((widget) => (
                <Select
                  key={widget.id}
                  label={widget.label}
                  disabled={!policy || busy}
                  value={
                    policy?.visibility[widget.id] === undefined
                      ? 'default'
                      : String(policy.visibility[widget.id])
                  }
                  onChange={(e) => {
                    if (!policy) return;
                    const visibility = { ...policy.visibility };
                    if (e.target.value === 'default') delete visibility[widget.id];
                    else visibility[widget.id] = e.target.value === 'true';
                    void action(() =>
                      command('/operator/desktop-overlay', { ...policy, visibility }),
                    );
                  }}
                >
                  <option value="default">跟随预设</option>
                  <option value="true">显示</option>
                  <option value="false">隐藏</option>
                </Select>
              ))}
              <Button
                disabled={!policy || busy}
                onClick={() =>
                  policy &&
                  void action(() =>
                    command('/operator/desktop-overlay', {
                      ...policy,
                      enabled: true,
                      visibility: { radar: false },
                    }),
                  )
                }
              >
                恢复默认
              </Button>
            </Panel>
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
