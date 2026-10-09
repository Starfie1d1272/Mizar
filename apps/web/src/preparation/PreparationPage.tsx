import { useEffect, useState } from 'react';
import type { ContextEnvelope } from '@mizar/core/match-context';
import type { MatchDocumentV1 } from '@mizar/protocol/context';
import { OperatorShell } from '../operator/OperatorShell';
import { RivalHubPreparationPanel } from '../operator/RivalHubPreparationPanel';
import { RivalHubSyncControls } from '../operator/RivalHubSyncControls';
import { LocalTournamentEditor } from '../workspace/LocalTournamentEditor';
import { ProductionStatus } from '../workspace/ProductionStatus';
import { BpWorkbench } from '../bp/BpPage';
import { Button, Panel, StatusBanner } from '../ui';
import { LocalMatchControls } from './LocalMatchControls';
import { MatchDocumentView } from './MatchDocumentView';
import { useLocalTournament } from './tournament';
import {
  openTool,
  productionAction,
  useLocalRead,
  useLocalReadWithTime,
  type Production,
} from './client';
import { RosterCapture } from './RosterCapture';
import { Settings } from './Settings';
import { AutomaticPreparation } from './AutomaticPreparation';
import { useCs2Status } from './cs2-status';
import { Cs2Recovery } from './Cs2Recovery';
import { SpectatorWorkflow } from './SpectatorWorkflow';
import { EventMatchWorkspace } from './EventMatchWorkspace';
import { PictureWorkspace } from './PictureWorkspace';
import { HudPresetDirectory } from './HudPresetDirectory';
import './preparation.css';
import './production.css';

const tasks = [
  ['match', '本场准备'],
  ['picture', '画面检查'],
  ['check', '开播检查'],
] as const;
const taskFor = (tab: string | null, path: string) =>
  tab === 'finish'
    ? 'finish'
    : tab === 'maps' || tab === 'bp'
      ? 'bp'
      : path === '/picture' || tab === 'hud' || tab === 'program' || tab === 'picture'
        ? 'picture'
        : tab === 'prepare' || tab === 'check'
          ? 'check'
          : 'match';
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
  const [task, setTask] = useState(() => taskFor(requested, path));
  const [visited, setVisited] = useState(() => new Set([taskFor(requested, path)]));
  const tab = isSettings ? (settings.find(([id]) => id === requested)?.[0] ?? 'gsi') : task;
  function navigateTask(next: string) {
    setTask(next);
    setVisited((current) => new Set([...current, next]));
    const url = new URL(window.location.href);
    url.pathname = '/';
    url.searchParams.set('tab', next);
    window.history.pushState(null, '', url);
  }
  useEffect(() => {
    const restore = () => {
      const next = taskFor(
        new URLSearchParams(window.location.search).get('tab'),
        window.location.pathname,
      );
      setTask(next);
      setVisited((current) => new Set([...current, next]));
    };
    window.addEventListener('popstate', restore);
    return () => window.removeEventListener('popstate', restore);
  }, []);
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
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [selecting, setSelecting] = useState(
    query.has('select') || query.has('createLocal') || query.has('createFromServer'),
  );
  const [selectionIntent, setSelectionIntent] = useState<'existing' | 'create' | 'online'>(() =>
    query.has('createLocal') || query.has('createFromServer') ? 'create' : 'existing',
  );
  const [matchDirty, setMatchDirty] = useState(false);
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
  const existing = production?.mode === 'hidden' || production?.mode === 'live';
  const canEdit = read.status === 'ready' && envelope?.freshness === 'fresh';
  return (
    <OperatorShell active={isSettings ? '/settings' : isResources ? '/resources' : '/'}>
      <main
        className="preparation production-page"
        data-task={isResources ? `resource-${requested ?? 'matches'}` : tab}
      >
        <header className="preparation-heading production-identity">
          <div role="region" aria-label="本场上下文">
            <h1>
              {isSettings
                ? '本机设置'
                : isResources
                  ? '资源'
                  : match
                    ? `${match.entrants.a.name} vs ${match.entrants.b.name}`
                    : '本场准备'}
            </h1>
            <p>
              {!isSettings && !isResources
                ? match
                  ? `${match.competition?.name ?? '独立比赛'} · ${match.format.toUpperCase()} · ${envelope?.source === 'local' ? '本地资料' : envelope?.source === 'fixture' ? '排练资料' : 'RivalHub'}${read.status === 'stale' || envelope?.freshness === 'stale' ? ' · 资料过期，只读' : ''}`
                  : '先建立本场，可离线准备名单、BP 与视觉。'
                : isResources
                  ? '浏览资源与当前制播分开；确认载入才切换本场。'
                  : '可复用的本机配置与诊断'}
            </p>
          </div>
          {!isSettings && !isResources ? (
            <div className="preparation-actions">
              <Button onClick={() => setSelecting((value) => !value)}>选择 / 切换本场</Button>
              <Button
                variant="primary"
                disabled={busy || matchDirty || !production?.canEnter}
                onClick={() =>
                  production &&
                  void action(() => productionAction('enter', production, setProgress))
                }
              >
                {existing
                  ? '返回现有现场'
                  : window.__TAURI_INTERNALS__
                    ? '启动新制作并进入现场'
                    : '进入制播工作区'}
              </Button>
              <details className="production-actions-menu">
                <summary>更多操作</summary>
                <Button onClick={() => navigateTask('finish')}>恢复与收尾</Button>
              </details>
            </div>
          ) : null}
        </header>
        {matchDirty ? (
          <p role="status">本场有未保存修改；任务切换保留草稿，进入现场前请先保存。</p>
        ) : null}
        {message ? <StatusBanner tone="danger">{message}</StatusBanner> : null}
        {progress ? <p role="status">{progress}</p> : null}
        {production?.cleanup && tab !== 'finish' ? (
          <StatusBanner tone="info">
            本场已有收尾回执。<a href="/?tab=finish">查看分项结果与继续恢复</a>
          </StatusBanner>
        ) : null}
        {!isSettings && !isResources ? (
          <>
            {read.status === 'stale' ? (
              <StatusBanner tone="warning">
                资料刷新失败，保留最近资料供核对，正式编辑待连接恢复。
              </StatusBanner>
            ) : null}
            {selecting || !match ? (
              <Panel className="production-selection">
                <h2>选择本场</h2>
                <div className="preparation-actions" aria-label="本场选择方式">
                  {(
                    [
                      ['existing', '已有本地比赛'],
                      ['create', '新建本地比赛'],
                      ['online', 'RivalHub'],
                    ] as const
                  ).map(([id, label]) => (
                    <Button
                      key={id}
                      aria-pressed={selectionIntent === id}
                      onClick={() => setSelectionIntent(id)}
                    >
                      {label}
                    </Button>
                  ))}
                </div>
                <div hidden={selectionIntent !== 'existing'}>
                  <LocalMatchControls
                    beforeApply={() =>
                      !matchDirty || window.confirm('本场资料有未保存修改，放弃草稿并切换？')
                    }
                    mode="select"
                    action={action}
                    onSelected={() => setSelecting(false)}
                  />
                </div>
                <div hidden={selectionIntent !== 'create'}>
                  <LocalMatchControls
                    beforeApply={() =>
                      !matchDirty || window.confirm('本场资料有未保存修改，放弃草稿并创建下一场？')
                    }
                    mode="create"
                    action={action}
                    onSelected={() => setSelecting(false)}
                  />
                  <details open={query.has('createFromServer')}>
                    <summary>从当前服务器识别双方 · 需有效 5v5 数据</summary>
                    <RosterCapture
                      create
                      autoOpen={query.has('createFromServer')}
                      onSaved={() => {
                        void refresh();
                        setSelecting(false);
                      }}
                    />
                  </details>
                </div>
                {selectionIntent === 'online' ? <RivalHubPreparationPanel mode="matches" /> : null}
              </Panel>
            ) : null}
            <nav className="preparation-tabs" aria-label="本场任务">
              {tasks.map(([id, label]) => (
                <Button
                  key={id}
                  aria-current={
                    task === id || (task === 'bp' && id === 'match') ? 'page' : undefined
                  }
                  onClick={() => navigateTask(id)}
                >
                  {label}
                </Button>
              ))}
            </nav>
            <Cs2Recovery production={production} />
          </>
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
            {query.get('returnTask') === 'check' || query.get('prepare') === '1' ? (
              <a href="/?tab=check">返回开播检查</a>
            ) : null}
            <Settings tab={tab} />
          </>
        ) : isResources ? (
          <>
            <nav className="preparation-tabs" aria-label="资源分区">
              <a href="/resources" aria-current={requested !== 'hud' ? 'page' : undefined}>
                赛事与比赛
              </a>
              <a href="/resources?tab=hud" aria-current={requested === 'hud' ? 'page' : undefined}>
                HUD 文件
              </a>
            </nav>
            {requested === 'hud' ? (
              <Panel>
                <h2>HUD 预设与文件</h2>
                <HudPresetDirectory action={action} />
                <Button onClick={() => void action(() => openTool('hud'))}>管理 HUD 资源</Button>
              </Panel>
            ) : view ? (
              <EventMatchWorkspace view={view} refresh={refresh} action={action} />
            ) : (
              <p>正在读取本地赛事与比赛；读取失败时不替换为样例。</p>
            )}
          </>
        ) : (
          <>
            <section hidden={task !== 'match'} aria-label="本场准备工作区">
              {match ? (
                <>
                  <div className="match-workspace-heading">
                    <div>
                      <h2>本场准备</h2>
                      <p>
                        {match.competition?.name ?? '独立比赛'} · {match.stageLabel || '阶段待填写'}{' '}
                        · 地图计划与双方首发在本场持续准备。
                      </p>
                    </div>
                    <Button variant="primary" onClick={() => navigateTask('bp')}>
                      准备正式 BP
                    </Button>
                  </div>
                  <RivalHubSyncControls />
                  {local && canEdit ? (
                    <LocalTournamentEditor
                      key={match.matchId}
                      document={match}
                      section="overview"
                      view={view}
                      refresh={refresh}
                      action={action}
                      scope="match"
                      onDirtyChange={setMatchDirty}
                    />
                  ) : (
                    <>
                      <MatchDocumentView document={match} section="details" />
                      <MatchDocumentView document={match} section="roster" />
                    </>
                  )}
                  <details className="match-plan-summary">
                    <summary>
                      地图计划与已保存禁选 ·{' '}
                      {match.maps.length ? `${match.maps.length} 张图` : '待准备 BP'}
                    </summary>
                    <MatchDocumentView document={match} section="maps" />
                  </details>
                  {local && canEdit ? (
                    <RosterCapture
                      names={{ a: match.entrants.a.name, b: match.entrants.b.name }}
                      onSaved={() => void refresh()}
                    />
                  ) : null}
                </>
              ) : (
                <Panel>
                  <h2>先建立双方，其他资料可以逐步补齐</h2>
                  <p>已有本地比赛、快速建立 BO 或 RivalHub 候选均可开始；无需先连接游戏设备。</p>
                </Panel>
              )}
            </section>
            <section hidden={task !== 'bp'} aria-label="正式 BP 子任务">
              <div className="match-workspace-heading">
                <h2>正式 BP · 影响播出</h2>
                <Button onClick={() => navigateTask('match')}>返回本场准备</Button>
              </div>
              <p>同一本场上下文；赛前可编辑与播放，无需 CS2 / GSI。返回本场保留资料草稿。</p>
              {visited.has('bp') ? <BpWorkbench /> : null}
            </section>
            <section hidden={task !== 'picture'} aria-label="画面检查工作区">
              {visited.has('picture') ? <PictureWorkspace action={action} /> : null}
            </section>
            <section hidden={task !== 'check'} aria-label="开播检查工作区">
              <div className="production-preflight">
                <Panel>
                  <h2>完成开播所需事项</h2>
                  <p>资料、BP 与样例预览可离线准备；真实比赛画面与雷达依赖进入观战后的有效数据。</p>
                  {!capabilities ? (
                    <p>正在读取检查状态，不推断已就绪。</p>
                  ) : (
                    <>
                      {capabilities
                        .filter((item) => !item.ready)
                        .map((item) => (
                          <a
                            className="preparation-readiness"
                            key={item.label}
                            href={`${item.href}${item.href.includes('?') ? '&' : '?'}returnTask=check`}
                          >
                            <div>
                              <strong>{item.label} · 待确认</strong>
                              <p>{item.reason}</p>
                            </div>
                            <span>{item.action ?? '检查 / 重查'}</span>
                          </a>
                        ))}
                      <details>
                        <summary>
                          已确认 {capabilities.filter((item) => item.ready).length} 项 ·
                          默认配置可复用
                        </summary>
                        {capabilities
                          .filter((item) => item.ready)
                          .map((item) => (
                            <p key={item.label}>
                              {item.label} · {item.reason}
                            </p>
                          ))}
                      </details>
                    </>
                  )}
                  <Button onClick={() => navigateTask('match')}>返回本场继续准备</Button>
                </Panel>
                <div>
                  <SpectatorWorkflow capabilities={capabilities} production={production} />
                  {match ? <ProductionStatus matchId={match.matchId} /> : null}
                </div>
              </div>
              {task === 'check' &&
              production?.mode === 'preparation' &&
              !cs2.status?.pending &&
              !cs2.phase &&
              (!window.__TAURI_INTERNALS__ || cs2.status !== null) ? (
                <AutomaticPreparation />
              ) : null}
            </section>
            <section hidden={task !== 'finish'} aria-label="恢复与收尾工作区">
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
                  推流和录制继续由你在 OBS
                  中操作；网站官方结果需另行提交。重试会重新执行整个收尾流程，请分别核对节目、网站数据源与
                  Host 回执。
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
            </section>
          </>
        )}
      </main>
    </OperatorShell>
  );
}
