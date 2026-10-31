import { SeriesBindingControls } from './SeriesBindingControls';
import { MatchBpSection } from './MatchBpSection';
import { useHudConfigClient } from '../realtime/hud-config-client';
import { hudStyleReference } from './hud-style-reference';
import { EventMatchWorkspace } from './EventMatchWorkspace';
import { HudPresetDirectory } from './HudPresetDirectory';
import { BpPresentationSettingsPanel } from './BpPresentationSettings';
import './production.css';
import { AutomaticPreparation } from './AutomaticPreparation';
import { DemoTestPanel } from './DemoTestPanel';
import { matchRound } from './match-presentation';
import { ProductionStatus } from '../workspace/ProductionStatus';
import type { ContextEnvelope } from '@mizar/core/match-context';
import type { MatchDocumentV1 } from '@mizar/protocol/context';
import type { ProductionGuidance } from '@mizar/protocol/program-scenes';
import { MatchDocumentView, type MatchSection } from './MatchDocumentView';
import { useEffect, useState } from 'react';
import { OperatorShell } from '../operator/OperatorShell';
import { RivalHubPreparationPanel } from '../operator/RivalHubPreparationPanel';
import { RivalHubSyncControls } from '../operator/RivalHubSyncControls';
import { desktopInvoke } from '../workspace/client';
import { LocalTournamentEditor } from '../workspace/LocalTournamentEditor';
import { Button, Dialog, Panel, StatusBanner, StatusPill } from '../ui';
import { LocalOverlayControls } from './LocalOverlayControls';
import { LocalMatchControls } from './LocalMatchControls';
import { useLocalTournament } from './tournament';
import {
  cancelProductionEntry,
  openTool,
  productionAction,
  useLocalRead,
  type Production,
} from './client';
import { Settings } from './Settings';
import { UpdateNotification } from './UpdateNotification';
import { DiagnosticDeliveryNotice } from '../debug/DiagnosticDeliveryNotice';
import { SpectatorHudCommands } from './SpectatorHudCommands';
import { Cs2Recovery } from './Cs2Recovery';
import { useWorkspaceExitStatus } from './cs2-status';
import { SpectatorWorkflow } from './SpectatorWorkflow';
import './preparation.css';

const tabs = {
  '/matches': [
    ['details', '比赛资料'],
    ['roster', '队伍与名单'],
  ],
  '/picture': [
    ['hud', '画面预览'],
    ['overlay', '本机 HUD'],
  ],
  '/settings': [
    ['gsi', '游戏与观战'],
    ['obs', 'OBS'],
    ['observer', '观察辅助'],
    ['music', '声音'],
    ['camera', '运镜'],
    ['rivalhub', 'RivalHub'],
    ['advanced', '高级'],
  ],
} as const;

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
  const query = new URLSearchParams(window.location.search);
  const requestedTab =
    query.get('tab') === 'music' && query.get('section') === 'camera' ? 'camera' : query.get('tab');
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
  const onAirHud = useHudConfigClient(path === '/');
  const matchGuidance = useLocalRead<ProductionGuidance>(
    path === '/matches' && (envelope?.source === 'rivalhub' || envelope?.source === 'cache')
      ? '/local/v1/production-guidance'
      : null,
    5000,
  );
  const { view, refresh, status: libraryStatus } = useLocalTournament();
  const local = envelope?.source === 'local' && view?.activeLocalMatchId === match?.matchId;
  const exit = useWorkspaceExitStatus();
  const production = useLocalRead<Production>('/local/v1/production');
  const rivalhub = useLocalRead<{ paired: boolean; displayName?: string | null }>(
    '/local/v1/rivalhub-connection',
  );
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [entering, setEntering] = useState(false);
  const [checkingEntry, setCheckingEntry] = useState(false);
  const [demoOpen, setDemoOpen] = useState(() =>
    new URLSearchParams(window.location.search).has('demoTest'),
  );
  const [librarySource, setLibrarySource] = useState<'local' | 'website'>(() =>
    new URLSearchParams(window.location.search).get('source') === 'website' ? 'website' : 'local',
  );

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
    if (!window.__TAURI_INTERNALS__) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const status = await desktopInvoke<{ running: boolean; message: string } | null>(
          'preparation_status',
        );
        if (active && status) {
          setEntering(status.running);
          if (!status.running && status.message) setMessage(status.message);
        }
      } catch {
        /* The desktop may still be starting. */
      }
      if (active) timer = setTimeout(() => void poll(), 1000);
    };
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    const enter = () => {
      void fetch('/local/v1/production', { cache: 'no-store' })
        .then((response) => response.json() as Promise<Production>)
        .then((current) => productionAction('enter', current))
        .catch((error: unknown) => {
          setMessage(error instanceof Error ? error.message : '操作未完成。');
        });
    };
    window.addEventListener('mizar-enter', enter);
    return () => {
      window.removeEventListener('mizar-enter', enter);
    };
  }, []);

  const tools = (
    <div className="preparation-actions">
      {(
        [
          ['hud', 'HUD 编辑器'],
          ['bp', '地图与禁选'],
          ['diagnostics', '运行诊断'],
        ] as const
      ).map(([tool, label]) => (
        <Button key={tool} onClick={() => void action(() => openTool(tool))}>
          {label}
        </Button>
      ))}
      <Button onClick={() => setDemoOpen(true)}>Demo 试播</Button>
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
    music: '声音',
    camera: '运镜',
    observer: '观察辅助',
    rivalhub: '赛事平台',
    advanced: '高级设置',
  };

  return (
    <OperatorShell active={path}>
      <main className="preparation" data-page={path}>
        <AutomaticPreparation />
        <UpdateNotification />
        <header className="preparation-heading">
          <div>
            <h1>
              {path === '/resources'
                ? '比赛库'
                : path === '/matches'
                  ? '比赛资料'
                  : path === '/picture'
                    ? '播出画面'
                    : path === '/settings'
                      ? (settingsTitle[tab] ?? '设置')
                      : '本场准备'}
            </h1>
          </div>
          <Button
            variant={match ? 'primary' : 'secondary'}
            disabled={busy || Boolean(exit?.busy) || !production}
            onClick={() =>
              production &&
              void action(async () => {
                setEntering(true);
                try {
                  await productionAction(
                    'enter',
                    production,
                    false,
                    undefined,
                    undefined,
                    setCheckingEntry,
                  );
                } finally {
                  setEntering(false);
                }
              })
            }
          >
            {entering
              ? checkingEntry
                ? '正在检查更新…'
                : '正在自动准备工作台…'
              : production?.mode === 'hidden'
                ? '返回工作台'
                : '启动并进入工作台'}
          </Button>
        </header>
        {production?.mode === 'preparation' ? (
          <p>启动时自动准备游戏和 OBS；如已有 CS2，将正常关闭后重新启动。</p>
        ) : null}
        {entering ? <Button onClick={cancelProductionEntry}>取消进入</Button> : null}
        {path === '/' && production?.mode === 'preparation' && window.__TAURI_INTERNALS__ ? (
          <DiagnosticDeliveryNotice />
        ) : null}

        {!(path === '/settings' && tab === 'gsi') ? <Cs2Recovery production={production} /> : null}
        {message ? (
          <StatusBanner tone="danger">
            {message}
            {message.includes('CS2 启动设置') ? (
              <p>
                <a href="/settings?tab=gsi">打开游戏启动设置</a>
              </p>
            ) : null}
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
          <div className="preparation-dashboard" data-selected={Boolean(match)}>
            {!match ? (
              <Panel className="preparation-task-panel">
                <div className="preparation-task-content">
                  <div className="preparation-task-header">
                    <div>
                      <h2>选择比赛</h2>
                      <p>先选择已有比赛，或创建本地比赛；只检查画面可用 Demo 试播。</p>
                    </div>
                  </div>
                  <div className="preparation-actions">
                    <Button
                      variant="primary"
                      onClick={() => {
                        window.location.href = '/resources';
                      }}
                    >
                      选择已有比赛
                    </Button>

                    {rivalhub?.paired ? (
                      <Button
                        variant="secondary"
                        onClick={() => {
                          window.location.href = '/resources?source=website';
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

                    <Button
                      variant="secondary"
                      onClick={() => {
                        window.location.href = '/matches?createLocal=1#local-match';
                      }}
                    >
                      创建本地比赛
                    </Button>
                  </div>
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
                      window.location.href = '/resources';
                    }}
                  >
                    切换比赛
                  </Button>
                </div>
              </Panel>
            )}

            {match ? (
              <nav className="preparation-task-links" aria-label="本场准备任务">
                <a href="/matches">
                  <div className="preparation-task-title">
                    <strong>
                      <small>01</small> 比赛资料
                    </strong>
                    <span>核对双方名单与赛程</span>
                  </div>
                  <div className="preparation-task-summary">
                    {(['a', 'b'] as const).map((side) => (
                      <div className="preparation-task-roster" key={side}>
                        <span title={match.entrants[side].name}>{match.entrants[side].name}</span>
                        <b>
                          {match.entrants[side].players.length
                            ? `首发 ${match.entrants[side].players.filter((p) => p.isStarter).length} 人`
                            : '名单待填写'}
                        </b>
                      </div>
                    ))}
                    <p>
                      {[match.stageLabel, matchRound(match)]
                        .filter(
                          (label, index) =>
                            label && (index === 0 || !match.stageLabel?.includes(label)),
                        )
                        .join(' · ') || '阶段与轮次待填写'}
                    </p>
                  </div>
                  <span className="preparation-task-entry">查看比赛资料 →</span>
                </a>
                <a
                  href="/matches#match-bp"
                  onClick={(event) => {
                    event.preventDefault();
                    window.location.href = '/matches#match-bp';
                  }}
                >
                  <div className="preparation-task-title">
                    <strong>
                      <small>02</small> 地图禁选
                    </strong>
                    <span>{match.format.toUpperCase()} · 地图与禁选资料</span>
                  </div>
                  <div className="preparation-task-summary">
                    <b>
                      {match.veto.length ? `已有 ${match.veto.length} 步 BP 记录` : '尚未录入 BP'}
                    </b>
                    {match.maps.length ? (
                      <ol className="preparation-task-maps">
                        {match.maps.map((map, index) => (
                          <li key={index}>
                            <small>{index + 1}</small>
                            {map.mapName.replace(/^de_/, '')}
                          </li>
                        ))}
                      </ol>
                    ) : (
                      <p>地图待确定，录入后在此查看。</p>
                    )}
                  </div>
                  <span className="preparation-task-entry">查看地图与禁选 →</span>
                </a>
                <a href="/picture?tab=hud">
                  <div className="preparation-task-title">
                    <strong>
                      <small>03</small> HUD 与包装
                    </strong>
                    <span>选择风格与调整布局</span>
                  </div>
                  <div className="preparation-task-summary">
                    {onAirHud.status === 'ready' ? (
                      <>
                        <b className="preparation-task-preset" title={onAirHud.current.preset.name}>
                          已启用 · {onAirHud.current.preset.name}
                        </b>
                        <figure className="preparation-task-reference">
                          <img
                            src={hudStyleReference(
                              onAirHud.current.widgets['top-score-bar'].variant,
                            )}
                            alt="HUD 风格参考"
                          />
                        </figure>
                      </>
                    ) : (
                      <p>
                        {onAirHud.status === 'loading'
                          ? '正在读取启用预设…'
                          : '暂时无法确认启用预设，请检查连接。'}
                      </p>
                    )}
                  </div>
                  <span className="preparation-task-entry">选择与编辑 →</span>
                </a>
              </nav>
            ) : null}
            <div className="preparation-overview">
              {match ? (
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
              ) : null}
              <Panel className="preparation-quick-tools">
                <h2>工具与试播</h2>
                {tools}
              </Panel>
            </div>
            <Dialog
              className="demo-test-dialog"
              title="Demo 试播"
              open={demoOpen}
              onClose={() => setDemoOpen(false)}
            >
              <DemoTestPanel forceExpanded={demoOpen} />
            </Dialog>

            <SpectatorWorkflow capabilities={capabilities} production={production} />
            {match && production && production.mode !== 'preparation' ? (
              <ProductionStatus matchId={match.matchId} />
            ) : null}
          </div>
        ) : path === '/resources' ? (
          <>
            <div className="preparation-library-sources" aria-label="比赛库来源">
              <Button
                variant={librarySource === 'local' ? 'primary' : 'secondary'}
                aria-pressed={librarySource === 'local'}
                onClick={() => setLibrarySource('local')}
              >
                本地赛事
              </Button>
              <Button
                variant={librarySource === 'website' ? 'primary' : 'secondary'}
                aria-pressed={librarySource === 'website'}
                onClick={() => setLibrarySource('website')}
              >
                RivalHub 赛事
              </Button>
            </div>
            <div hidden={librarySource !== 'local'}>
              {libraryStatus !== 'ready' ? (
                <StatusBanner tone="warning">
                  {libraryStatus === 'loading'
                    ? '正在读取比赛库…'
                    : '比赛库读取失败，保留最近资料与草稿；连接恢复前暂停保存和载入。'}
                </StatusBanner>
              ) : null}
              {view ? (
                <EventMatchWorkspace
                  view={view}
                  refresh={refresh}
                  action={action}
                  canWrite={libraryStatus === 'ready'}
                />
              ) : null}
              <details>
                <summary>回收站与本地管理</summary>
                <LocalMatchControls mode="select" action={action} />
              </details>
            </div>
            {librarySource === 'website' ? <RivalHubPreparationPanel mode="matches" /> : null}
          </>
        ) : path === '/matches' ? (
          <>
            <RivalHubSyncControls />
            <details
              className="preparation-switch"
              open={!match || createFromServer || openMatchSelection}
            >
              <summary>切换比赛</summary>
              {!match ? (
                <p>只需队名与赛制即可创建本地比赛；进入现场并连接服务器后，可识别十人名单。</p>
              ) : null}
              <h2 id="local-match">本地比赛</h2>
              <LocalMatchControls action={action} />
              <h2>RivalHub</h2>
              <RivalHubPreparationPanel mode="matches" />
            </details>
            {match && local ? (
              <>
                {tab === 'roster' ? (
                  <StatusBanner tone="info">
                    现场首发可在工作台连接服务器后识别；这里维护队伍资料与完整名单。
                  </StatusBanner>
                ) : null}
                {tab === 'details' ? (
                  <MatchDocumentView document={match} section="details" />
                ) : null}
                <details open={tab === 'roster'}>
                  <summary>{tab === 'roster' ? '编辑队伍与名单' : '编辑比赛资料'}</summary>
                  <LocalTournamentEditor
                    document={match}
                    section={tab as MatchSection}
                    view={view}
                    refresh={refresh}
                    action={action}
                  />
                </details>
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
                <MatchDocumentView document={match} section={tab as MatchSection} />
              </>
            ) : null}
            {tab === 'details' && match ? (
              <MatchBpSection
                document={match}
                local={local}
                contextRevision={view?.contextRevision}
              />
            ) : null}
            {tab === 'details' && production && production.mode !== 'preparation' ? (
              <details>
                <summary>现场地图对应（异常时处理）</summary>
                <SeriesBindingControls />
              </details>
            ) : null}
          </>
        ) : path === '/picture' ? (
          tab === 'hud' ? (
            <>
              <HudPresetDirectory action={action} />
              <BpPresentationSettingsPanel />
            </>
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
