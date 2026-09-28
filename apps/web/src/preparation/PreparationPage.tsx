import type { ContextEnvelope } from '@mizar/core/match-context';
import type { MatchDocumentV1 } from '@mizar/protocol/context';
import { MatchDocumentView, type MatchSection } from './MatchDocumentView';
import { useEffect, useState } from 'react';
import { HUD_WIDGET_REGISTRY } from '@mizar/hud-config';
import { OperatorShell } from '../operator/OperatorShell';
import { RivalHubPreparationPanel } from '../operator/RivalHubPreparationPanel';
import { useHudConfigClient } from '../realtime/hud-config-client';
import { useProgramScenes } from '../workspace/client';
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
  const { view, refresh } = useLocalTournament();
  const local = envelope?.source === 'local' && view?.activeLocalMatchId === match?.matchId;
  const scenes = useProgramScenes();
  const hud = useHudConfigClient();
  const production = useLocalRead<Production>('/local/v1/production');
  const policy = useLocalRead<OverlayPolicy>('/local/v1/desktop-overlay');
  const rivalhub = useLocalRead<{ paired: boolean }>('/local/v1/rivalhub-connection');
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
        <Button key={tool} disabled={busy} onClick={() => void action(() => openTool(tool))}>
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
      <main className="preparation">
        <header className="preparation-heading">
          <div>
            <p>制作准备</p>
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
        {(path === '/' || path === '/matches') && match ? (
          <Panel className="preparation-match">
            <div className="preparation-match__meta">
              <span>
                {match.competition.name} · {match.format.toUpperCase()}
              </span>
              <StatusPill tone="info">
                {envelope?.source === 'local' ? '本地比赛' : 'RivalHub'}
                {envelope?.freshness === 'stale' ? ' · 缓存资料' : ''}
              </StatusPill>
            </div>
            <h2>
              {match.entrants.a.name}
              <span>vs</span>
              {match.entrants.b.name}
            </h2>
            {match ? (
              <p>
                {[
                  match.stageLabel,
                  match.roundLabel,
                  match.matchLabel,
                  match.scheduledAt ? new Date(match.scheduledAt).toLocaleString('zh-CN') : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </p>
            ) : null}
            {path === '/' ? <a href="/matches">查看比赛资料</a> : null}
          </Panel>
        ) : null}
        {path === '/' ? (
          <>
            {!match ? (
              <Panel>
                <h2>准备下一场制作</h2>
                <p>先选一场比赛，再按需完善画面与连接。</p>
                <div className="preparation-actions">
                  <CurrentServerMatchEntry />
                  <a href="/matches">新建本地比赛</a>
                  <a href={rivalhub?.paired ? '/matches' : '/settings?tab=rivalhub'}>
                    {rivalhub?.paired ? '从 RivalHub 选择比赛' : '连接 RivalHub'}
                  </a>
                </div>
              </Panel>
            ) : null}
            <div className="preparation-overview">
              <Panel>
                <h2>制作就绪</h2>
                <p>各项能力独立准备，有比赛即可进入现场。</p>
                {readiness.map(([label, ready, reason, href]) => (
                  <a className="preparation-readiness" key={label} href={href}>
                    <span>{label}</span>
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
                  {attention.map(({ label, action, href }) => (
                    <a className="preparation-attention" key={label} href={href}>
                      <strong>{action} →</strong>
                    </a>
                  ))}
                </Panel>
                <Panel>
                  <h2>制作工具</h2>
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
                  key={`${match.matchId}:${envelope?.revision}:${view?.contextRevision}:${tab}`}
                  document={match}
                  view={view}
                  refresh={refresh}
                  action={action}
                  section={tab as 'details' | 'roster' | 'maps'}
                />
              </>
            ) : match ? (
              <>
                <StatusBanner tone="info">
                  {envelope?.source === 'local'
                    ? '正在读取本地编辑状态。'
                    : '赛事资料由 RivalHub 管理，请通过赛务流程更新。'}
                </StatusBanner>
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
    <a href="/matches?tab=roster&createFromServer=1">从当前服务器创建比赛</a>
  ) : null;
}
