import { useEffect, useState } from 'react';
import type { ContextEnvelope } from '@mizar/core/match-context';
import type { MatchDocumentV1 } from '@mizar/protocol/context';
import { OperatorShell } from '../operator/OperatorShell';
import { RivalHubPreparationPanel } from '../operator/RivalHubPreparationPanel';
import { RivalHubSyncControls } from '../operator/RivalHubSyncControls';
import { useHudConfigClient } from '../realtime/hud-config-client';
import { LocalTournamentEditor } from '../workspace/LocalTournamentEditor';
import { ProductionStatus } from '../workspace/ProductionStatus';
import { BpWorkbench } from '../bp/BpPage';
import { Button, Panel, Select, StatusBanner, StatusPill } from '../ui';
import { LocalMatchControls } from './LocalMatchControls';
import { LocalOverlayControls } from './LocalOverlayControls';
import { SpectatorHudCommands } from './SpectatorHudCommands';
import { MatchDocumentView, type MatchSection } from './MatchDocumentView';
import { useLocalTournament } from './tournament';
import {
  command,
  openTool,
  productionAction,
  useLocalRead,
  useLocalReadWithTime,
  type Production,
} from './client';
import { RosterCapture } from './RosterCapture';
import { Settings } from './Settings';
import { AutomaticPreparation } from './AutomaticPreparation';
import { ProgramPreview } from './ProgramPreview';
import { useCs2Status } from './cs2-status';
import { Cs2Recovery } from './Cs2Recovery';
import { SpectatorWorkflow } from './SpectatorWorkflow';
import './preparation.css';
import './production.css';

const tasks = [
  ['prepare', '开播检查'],
  ['details', '本场资料'],
  ['roster', '双方与首发'],
  ['maps', '地图与正式 BP'],
  ['hud', 'HUD 与本机显示'],
  ['program', '画面检查'],
  ['finish', '恢复与收尾'],
] as const;
const settings = [
  ['gsi', 'CS2 / GSI'],
  ['obs', 'OBS'],
  ['rivalhub', 'RivalHub'],
  ['advanced', '更新与支持'],
] as const;

export function PreparationPage() {
  const path = window.location.pathname;
  const query = new URLSearchParams(window.location.search);
  const isSettings = path === '/settings';
  const isResources = path === '/resources';
  const requested = query.get('tab');
  const tab = isSettings
    ? (settings.find(([id]) => id === requested)?.[0] ?? 'gsi')
    : path === '/matches'
      ? (requested ?? 'details')
      : path === '/picture'
        ? (requested ?? 'program')
        : (tasks.find(([id]) => id === requested)?.[0] ?? 'prepare');
  const read = useLocalReadWithTime<ContextEnvelope<MatchDocumentV1>>(
    '/local/v1/match-document',
    2000,
    0,
    true,
  );
  const envelope = read.value;
  const match = envelope?.document;
  const { view, refresh } = useLocalTournament();
  const cs2 = useCs2Status();
  const production = useLocalRead<Production>('/local/v1/production');
  const capabilities =
    useLocalRead<
      { label: string; ready: boolean; reason: string; href: string; action: string | null }[]
    >('/local/v1/readiness');
  const hud = useHudConfigClient();
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [selecting, setSelecting] = useState(
    query.has('select') || query.has('createLocal') || query.has('createFromServer'),
  );
  const [resourceId, setResourceId] = useState('');
  const [resourceSection, setResourceSection] = useState<MatchSection>('details');
  const [progress, setProgress] = useState('');
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
      void action(async () => {
        const response = await fetch('/local/v1/production', { cache: 'no-store' });
        if (!response.ok) throw new Error('无法读取制作状态。');
        await productionAction('enter', (await response.json()) as Production, setProgress);
      });
    };
    window.addEventListener('mizar-enter', enter);
    return () => window.removeEventListener('mizar-enter', enter);
  });
  const local = envelope?.source === 'local' && view?.activeLocalMatchId === match?.matchId;
  const resource = view?.matches.find((item) => item.matchId === resourceId) ?? view?.matches[0];
  const existing = production?.mode === 'hidden' || production?.mode === 'live';
  const canEdit = read.status === 'ready' && envelope?.freshness === 'fresh';
  return (
    <OperatorShell active={isSettings ? '/settings' : isResources ? '/resources' : '/'}>
      <main
        className="preparation production-page"
        data-task={isResources ? `resource-${requested ?? 'matches'}` : tab}
      >
        <header className="preparation-heading">
          <div>
            <h1>{isSettings ? '本机设置' : isResources ? '资源' : '本场制播'}</h1>
            <p>
              {isSettings
                ? '长期配置与诊断，准备完成后可持续复用。'
                : isResources
                  ? '浏览跨场资源不会替换正在制作的比赛。'
                  : '准备、正式播出与安全收尾，围绕同一场比赛推进。'}
            </p>
          </div>
          {!isSettings && !isResources ? (
            <Button
              variant="primary"
              disabled={busy || !production?.canEnter}
              onClick={() =>
                production && void action(() => productionAction('enter', production, setProgress))
              }
            >
              {existing
                ? '返回现有现场'
                : window.__TAURI_INTERNALS__
                  ? '启动新制作并进入现场'
                  : '进入制播工作区'}
            </Button>
          ) : null}
        </header>
        {message ? <StatusBanner tone="danger">{message}</StatusBanner> : null}
        {progress ? <p role="status">{progress}</p> : null}
        {production?.cleanup && tab !== 'finish' ? (
          <StatusBanner tone="info">
            本场已有收尾回执。<a href="/?tab=finish">查看分项结果与继续恢复</a>
          </StatusBanner>
        ) : null}
        {!isSettings && !isResources ? (
          <>
            <section className="production-context" aria-label="本场上下文">
              <div>
                <strong>
                  {match
                    ? `${match.entrants.a.name} vs ${match.entrants.b.name}`
                    : read.status === 'loading'
                      ? '正在读取本场'
                      : '尚未选择比赛'}
                </strong>
                <p>
                  {match
                    ? `${match.competition?.name ?? '独立比赛'} · ${match.format.toUpperCase()} · ${match.matchLabel ?? match.matchId}`
                    : '先创建本地比赛，或确认 RivalHub 比赛候选。'}
                </p>
              </div>
              <StatusPill tone={read.status === 'stale' ? 'warning' : 'info'}>
                {envelope?.source === 'local'
                  ? '本地资料'
                  : envelope?.source === 'fixture'
                    ? '排练资料'
                    : envelope
                      ? 'RivalHub'
                      : '来源待确认'}
                {read.status === 'stale' || envelope?.freshness === 'stale'
                  ? ' · 资料过期，只读'
                  : ''}
              </StatusPill>
              <Button onClick={() => setSelecting((value) => !value)}>选择 / 切换本场</Button>
            </section>
            {read.status === 'stale' ? (
              <StatusBanner tone="warning">
                资料刷新失败，保留最近读取的资料（
                {read.updatedAt ? new Date(read.updatedAt).toLocaleTimeString('zh-CN') : '时间未知'}
                ）。正式编辑待连接恢复后再操作。
              </StatusBanner>
            ) : null}
            {selecting || (!match && tab === 'prepare') ? (
              <Panel className="production-selection">
                <h2>选择本场</h2>
                <RosterCapture
                  create
                  autoOpen={query.has('createFromServer')}
                  onSaved={() => void refresh()}
                />
                <LocalMatchControls action={action} onSelected={() => setSelecting(false)} />
                <RivalHubPreparationPanel mode="matches" />
              </Panel>
            ) : null}
            <nav className="preparation-tabs" aria-label="本场任务">
              {tasks.map(([id, label]) => (
                <a key={id} href={`/?tab=${id}`} aria-current={tab === id ? 'page' : undefined}>
                  {label}
                </a>
              ))}
            </nav>
            <Cs2Recovery production={production} />
          </>
        ) : null}
        {!isSettings &&
        !isResources &&
        tab === 'prepare' &&
        production?.mode === 'preparation' &&
        !cs2.status?.pending &&
        !cs2.phase &&
        (!window.__TAURI_INTERNALS__ || cs2.status !== null) ? (
          <AutomaticPreparation />
        ) : null}
        {isSettings ? (
          <>
            <nav className="preparation-tabs" aria-label="设置分区">
              {settings.map(([id, label]) => (
                <a
                  key={id}
                  href={`/settings?tab=${id}`}
                  aria-current={tab === id ? 'page' : undefined}
                >
                  {label}
                </a>
              ))}
            </nav>
            {tab !== 'gsi' ? <Cs2Recovery production={production} /> : null}
            <Settings tab={tab} />
          </>
        ) : isResources ? (
          <>
            <nav className="preparation-tabs" aria-label="资源分区">
              {(
                [
                  ['matches', '比赛与队伍'],
                  ['event', '赛事与赛程'],
                  ['hud', 'HUD 文件'],
                ] as const
              ).map(([id, label]) => (
                <a
                  key={id}
                  href={`/resources?tab=${id}`}
                  aria-current={(requested ?? 'matches') === id ? 'page' : undefined}
                >
                  {label}
                </a>
              ))}
            </nav>
            {(requested ?? 'matches') === 'matches' ? (
              <Panel>
                <h2>本地比赛与队伍</h2>
                <p>在资源中核对赛事与赛程；载入比赛需明确确认。</p>
                <Select
                  label="浏览比赛资源"
                  value={resource?.matchId ?? ''}
                  onChange={(e) => setResourceId(e.target.value)}
                >
                  {view?.matches.map((item) => (
                    <option key={item.matchId} value={item.matchId}>
                      {item.entrants.a.name} vs {item.entrants.b.name}
                    </option>
                  ))}
                </Select>
                {resource ? (
                  <>
                    <MatchDocumentView document={resource} section="details" />
                    <Button
                      onClick={() => {
                        if (
                          window.confirm(
                            `将本场切换为 ${resource.entrants.a.name} vs ${resource.entrants.b.name}？`,
                          )
                        )
                          void action(async () => {
                            await command('/operator/local-match/select', {
                              matchId: resource.matchId,
                            });
                            window.location.assign('/?tab=details');
                          });
                      }}
                    >
                      确认载入为本场
                    </Button>
                  </>
                ) : (
                  <p>暂无本地比赛，在制播中创建后即可复用。</p>
                )}
                <ul>
                  {view?.teams.map((team) => (
                    <li key={team.teamId}>{team.name}</li>
                  ))}
                </ul>
              </Panel>
            ) : requested === 'event' && resource ? (
              <Panel>
                <h2>赛事资产与默认规则</h2>
                <Select
                  label="资源编辑区域"
                  value={resourceSection}
                  onChange={(e) => setResourceSection(e.target.value as MatchSection)}
                >
                  <option value="details">赛事资料 / 赛程顺序</option>
                  <option value="maps">默认地图池 / BO3 规则</option>
                </Select>
                <LocalTournamentEditor
                  key={`${resource.matchId}:${resourceSection}`}
                  document={resource}
                  view={view}
                  refresh={refresh}
                  action={action}
                  section={resourceSection}
                  scope="resources"
                />
              </Panel>
            ) : requested === 'hud' ? (
              <Panel>
                <h2>HUD 预设与文件</h2>
                <p>
                  五套预设、布局引用、导入和导出均在真实编辑器管理。选择与保存资源不会自动应用到播出。
                </p>
                <Button onClick={() => void action(() => openTool('hud'))}>管理 HUD 资源</Button>
              </Panel>
            ) : (
              <p>暂无赛事资源，请先创建本地比赛。</p>
            )}
          </>
        ) : selecting || (!match && tab === 'prepare') ? null : tab === 'prepare' ? (
          <>
            <div className="production-preflight">
              <div>
                <Panel>
                  <h2>开播检查</h2>
                  {capabilities ? (
                    capabilities.map((item) => (
                      <a className="preparation-readiness" key={item.label} href={item.href}>
                        <div>
                          <strong>
                            {item.label} · {item.ready ? '已确认' : '待处理 / 待确认'}
                          </strong>
                          <p>{item.reason}</p>
                        </div>
                        <span>{item.action ?? '查看'}</span>
                      </a>
                    ))
                  ) : (
                    <p>正在读取本地检查状态。</p>
                  )}
                </Panel>
                {match ? <ProductionStatus matchId={match.matchId} /> : null}
              </div>
              <SpectatorWorkflow capabilities={capabilities} production={production} />
            </div>
          </>
        ) : ['details', 'roster', 'maps'].includes(tab) ? (
          <>
            <RivalHubSyncControls />
            {match ? (
              local && canEdit ? (
                <>
                  {tab === 'roster' ? (
                    <RosterCapture
                      names={{ a: match.entrants.a.name, b: match.entrants.b.name }}
                      onSaved={() => void refresh()}
                    />
                  ) : null}
                  {tab !== 'maps' ? (
                    <LocalTournamentEditor
                      key={`${match.matchId}:${tab}`}
                      document={match}
                      section={tab as MatchSection}
                      view={view}
                      refresh={refresh}
                      action={action}
                      scope="match"
                    />
                  ) : null}
                </>
              ) : (
                <MatchDocumentView document={match} section={tab as MatchSection} />
              )
            ) : (
              <p>请先选择本场。</p>
            )}
            {tab === 'maps' ? (
              <Panel>
                <h2>正式 BP 控制 · 影响播出</h2>
                <p>赛前即可编辑与播放 BP，无需启动 CS2 或等待 GSI。画面检查仅用于只读预览。</p>
                <BpWorkbench />
              </Panel>
            ) : null}
          </>
        ) : tab === 'hud' || tab === 'overlay' ? (
          <>
            <Panel>
              <h2>正式播出 · {hud.current.preset.name}</h2>
              <p>
                布局：{hud.current.layout.name} · 外观：{hud.current.theme.name}
              </p>
              <p>编辑、保存与应用到播出是独立操作。五套 HUD 的真实画布与预设文件在编辑器中操作。</p>
              <Button onClick={() => void action(() => openTool('hud'))}>
                编辑 / 选择 HUD 与导入导出
              </Button>
            </Panel>
            <Panel>
              <h2>本机显示</h2>
              <p>仅影响本机覆盖层，OBS 继续使用正式启用预设。</p>
              <LocalOverlayControls />
              <SpectatorHudCommands />
            </Panel>
            <a href="/?tab=program">下一步：检查节目画面 →</a>
          </>
        ) : tab === 'finish' ? (
          <Panel>
            <h2>恢复与收尾</h2>
            {production?.cleanup ? (
              <ul aria-label="Companion 清理回执">
                <li>
                  收起节目 ·{' '}
                  {production.cleanup.scene === 'confirmed'
                    ? '已确认'
                    : production.cleanup.scene === 'failed'
                      ? '失败，可重试'
                      : '待确认'}
                </li>
                <li>
                  释放网站数据源 ·{' '}
                  {production.cleanup.source === 'confirmed'
                    ? '已确认'
                    : production.cleanup.source === 'failed'
                      ? '失败，可重试'
                      : '待确认'}
                </li>
                <li>回执时间 · {new Date(production.cleanup.at).toLocaleString('zh-CN')}</li>
              </ul>
            ) : (
              <p>尚无本次服务的收尾回执。</p>
            )}
            <p>
              结束制播会收起节目、释放本机网站源、关闭受管理 CS2 并恢复配置。OBS
              推流和录制继续由你在 OBS 中操作；网站官方结果需另行提交。
            </p>
            <p>
              Host 游戏与配置 ·{' '}
              {window.__TAURI_INTERNALS__
                ? cs2.error
                  ? '读取失败，请重查'
                  : cs2.phase
                    ? '正在操作'
                    : cs2.status
                      ? cs2.status.pending
                        ? '备份尚待恢复'
                        : cs2.status.running
                          ? '游戏仍在运行'
                          : '未检测到受管理游戏或待恢复备份'
                      : '正在读取'
                : '浏览器无法验收 Windows 游戏与配置'}
            </p>
            <ProductionStatus matchId={match?.matchId ?? null} />
            <Button
              disabled={busy || !production}
              onClick={() => {
                if (
                  production &&
                  window.confirm(
                    '结束本场制作、关闭受管理游戏并恢复配置？OBS 推流 / 录制不会自动停止。',
                  )
                )
                  void action(() => productionAction('finish', production, setProgress));
              }}
            >
              结束制播 / 重试收尾
            </Button>
          </Panel>
        ) : (
          <ProgramPreview />
        )}
      </main>
    </OperatorShell>
  );
}
