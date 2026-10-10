import { useEffect, useState } from 'react';
import type { ContextEnvelope } from '@mizar/core/match-context';
import type { MatchDocumentV1 } from '@mizar/protocol/context';
import { OperatorShell } from '../operator/OperatorShell';
import { RivalHubPreparationPanel } from '../operator/RivalHubPreparationPanel';
import { RivalHubSyncControls } from '../operator/RivalHubSyncControls';
import { LocalTournamentEditor } from '../workspace/LocalTournamentEditor';
import { ProductionStatus } from '../workspace/ProductionStatus';
import { ObsConfidence } from '../workspace/WorkspacePage';
import { BpWorkbench } from '../bp/BpPage';
import { Button, Panel, StatusBanner } from '../ui';
import { LocalMatchControls } from './LocalMatchControls';
import { MatchDocumentView } from './MatchDocumentView';
import { useLocalTournament } from './tournament';
import {
  openTool,
  productionAction,
  productionEntryLabel,
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
import { OfficialResourceStatus } from './OfficialResourceStatus';
import { HudPresetDirectory } from './HudPresetDirectory';
import './preparation.css';
import './production.css';

const tasks = [
  ['match', '资料'],
  ['picture', '画面'],
  ['check', '开播'],
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
  ['preferences', '偏好'],
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
  const { view, refresh, status: tournamentStatus } = useLocalTournament();
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
      if (matchDirty) {
        setMessage('本场有未保存修改，请先保存资料再进入现场；当前草稿保留。');
        return;
      }
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
                  ? requested === 'hud'
                    ? 'HUD'
                    : '比赛库'
                  : match
                    ? tab === 'picture'
                      ? '画面'
                      : tab === 'check'
                        ? '开播'
                        : '本场资料'
                    : '本场准备'}
            </h1>
            <p>
              {!isSettings && !isResources
                ? match
                  ? `${match.entrants.a.name} vs ${match.entrants.b.name} · ${match.competition?.name ?? '独立比赛'} · ${match.format.toUpperCase()} · ${envelope?.source === 'local' ? '本地资料' : envelope?.source === 'fixture' ? '排练资料' : 'RivalHub'}${read.status === 'stale' || envelope?.freshness === 'stale' ? ' · 资料过期，只读' : ''}`
                  : '先建立本场，可离线准备名单、BP 与视觉。'
                : isResources
                  ? requested === 'hud'
                    ? '预设与播出配置'
                    : '赛事 · 赛程 · 阵容'
                  : '可复用的本机配置与诊断'}
            </p>
          </div>
          {!isSettings && !isResources ? (
            <div className="preparation-actions">
              <Button onClick={() => setSelecting((value) => !value)}>选择 / 切换本场</Button>
              {tab === 'check' ? (
                <Button
                  variant={tab === 'check' ? 'primary' : 'secondary'}
                  disabled={busy || matchDirty || !production?.canEnter}
                  onClick={() =>
                    production &&
                    void action(() => productionAction('enter', production, setProgress))
                  }
                >
                  {productionEntryLabel(production, Boolean(window.__TAURI_INTERNALS__))}
                </Button>
              ) : null}
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
        {tournamentStatus === 'stale' ? (
          <StatusBanner tone="warning">
            赛事读取失败，保留最近资料与草稿；连接恢复并核对前禁止保存或载入。
          </StatusBanner>
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
                资料刷新失败，保留最近资料与草稿供核对；恢复连接前禁止保存。
              </StatusBanner>
            ) : null}
            {selecting || (!match && ['match', 'bp'].includes(task)) ? (
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
                    onCancel={() => {
                      setSelecting(false);
                      setSelectionIntent('existing');
                    }}
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
            {match && !selecting ? (
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
            ) : null}
            <Cs2Recovery production={production} />
          </>
        ) : null}
        {isSettings ? (
          <>
            <nav className="preparation-tabs" aria-label="设置分区">
              {(
                [
                  ['gsi', '本机连接'],
                  ['preferences', '偏好'],
                  ['advanced', '更新与支持'],
                ] as const
              ).map(([id, label]) => (
                <a
                  key={id}
                  href={`/settings?tab=${id}`}
                  aria-current={
                    (id === 'gsi' ? ['gsi', 'obs', 'rivalhub'].includes(tab) : tab === id)
                      ? 'page'
                      : undefined
                  }
                >
                  {label}
                </a>
              ))}
            </nav>
            {tab !== 'preferences' ? <Cs2Recovery production={production} /> : null}
            {query.get('returnTask') === 'check' || query.get('prepare') === '1' ? (
              <a href="/?tab=check">返回开播检查</a>
            ) : null}
            {['gsi', 'obs', 'rivalhub'].includes(tab) ? (
              <nav className="settings-connection-tabs" aria-label="本机连接">
                {settings
                  .filter(([id]) => ['gsi', 'obs', 'rivalhub'].includes(id))
                  .map(([id, label]) => (
                    <a
                      key={id}
                      href={`/settings?tab=${id}`}
                      aria-current={tab === id ? 'page' : undefined}
                    >
                      {label}
                    </a>
                  ))}
              </nav>
            ) : null}
            <Settings tab={tab} />
          </>
        ) : isResources ? (
          <>
            {requested === 'hud' ? (
              <section className="hud-resource-workspace">
                <HudPresetDirectory action={action} />
                <Button onClick={() => void action(() => openTool('hud'))}>管理 HUD 资源</Button>
                <details>
                  <summary>官方演练素材</summary>
                  <OfficialResourceStatus />
                </details>
              </section>
            ) : view ? (
              <EventMatchWorkspace
                view={view}
                refresh={refresh}
                action={action}
                canWrite={tournamentStatus === 'ready'}
              />
            ) : (
              <p>正在读取本地赛事与比赛；读取失败时不替换为样例。</p>
            )}
          </>
        ) : (
          <>
            <section
              className="match-task"
              hidden={task !== 'match' || selecting || !match}
              aria-label="本场准备工作区"
            >
              {match ? (
                <>
                  <RivalHubSyncControls />
                  {local ? (
                    <LocalTournamentEditor
                      key={match.matchId}
                      document={match}
                      section="overview"
                      view={view}
                      refresh={refresh}
                      action={action}
                      scope="match"
                      canSave={canEdit && tournamentStatus === 'ready'}
                      onDirtyChange={setMatchDirty}
                      onNext={() => navigateTask('picture')}
                      rosterTools={
                        canEdit ? (
                          <RosterCapture
                            names={{ a: match.entrants.a.name, b: match.entrants.b.name }}
                            onSaved={() => void refresh()}
                          />
                        ) : null
                      }
                      afterRoster={
                        <div className="match-plan-row">
                          <details className="match-plan-summary">
                            <summary>
                              地图计划与已保存禁选 ·{' '}
                              {match.maps.length ? `${match.maps.length} 张图` : '待准备 BP'}
                            </summary>
                            <MatchDocumentView document={match} section="maps" />
                          </details>
                          <Button onClick={() => navigateTask('bp')}>准备正式 BP</Button>
                        </div>
                      }
                    />
                  ) : (
                    <>
                      <MatchDocumentView document={match} section="details" />
                      <MatchDocumentView document={match} section="roster" />
                      <details className="match-plan-summary">
                        <summary>
                          地图计划与已保存禁选 ·{' '}
                          {match.maps.length ? `${match.maps.length} 张图` : '待准备 BP'}
                        </summary>
                        <MatchDocumentView document={match} section="maps" />
                      </details>

                      <Button onClick={() => navigateTask('bp')}>准备正式 BP</Button>
                    </>
                  )}
                </>
              ) : null}
            </section>
            <section hidden={task !== 'bp' || selecting || !match} aria-label="正式 BP 子任务">
              <div className="match-workspace-heading">
                <h2>正式 BP · 影响播出</h2>
                <Button onClick={() => navigateTask('match')}>返回本场准备</Button>
              </div>
              <p>同一本场上下文；赛前可编辑与播放，无需 CS2 / GSI。返回本场保留资料草稿。</p>
              {visited.has('bp') ? <BpWorkbench /> : null}
            </section>
            <section hidden={task !== 'picture' || selecting} aria-label="画面检查工作区">
              {visited.has('picture') ? (
                <PictureWorkspace action={action} onNext={() => navigateTask('check')} />
              ) : null}
            </section>
            <section hidden={task !== 'check' || selecting} aria-label="开播检查工作区">
              <div className="production-preflight">
                <section className="preflight-checklist" aria-label="开播检查列表">
                  <h2>开播检查</h2>
                  {!capabilities ? (
                    <p role="status">正在读取检查状态</p>
                  ) : (
                    capabilities
                      .filter((item) =>
                        ['CS2 / GSI', 'OBS', '比赛上下文', '比赛画面'].includes(item.label),
                      )
                      .map((item) => (
                        <details key={item.label} open={!item.ready}>
                          <summary>
                            {item.label} · {item.ready ? '已确认' : '待处理'}
                          </summary>
                          <p>{item.reason}</p>
                          {!item.ready ? (
                            <a
                              href={`${item.href}${item.href.includes('?') ? '&' : '?'}returnTask=check`}
                            >
                              {item.action ?? '检查 / 重查'}
                            </a>
                          ) : null}
                        </details>
                      ))
                  )}
                  {capabilities ? (
                    <details>
                      <summary>画面与身份详情</summary>
                      {capabilities
                        .filter(
                          (item) =>
                            !['CS2 / GSI', 'OBS', '比赛上下文', '比赛画面'].includes(item.label),
                        )
                        .map((item) => (
                          <p key={item.label}>
                            {item.label} · {item.ready ? '已确认' : item.reason}
                            {!item.ready ? (
                              <>
                                {' '}
                                · <a href={item.href}>检查</a>
                              </>
                            ) : null}
                          </p>
                        ))}
                    </details>
                  ) : null}
                  <SpectatorWorkflow capabilities={capabilities} production={production} />
                  <Button onClick={() => navigateTask('match')}>返回本场继续准备</Button>
                </section>
                <section className="preflight-confidence" aria-label="开播画面确认">
                  <h2>OBS 实际画面</h2>
                  <ObsConfidence />
                  {match ? <ProductionStatus matchId={match.matchId} /> : null}
                  <a href="/settings?tab=obs&returnTask=check">检查 OBS 连接与音画</a>
                  <small>缩略图无声音；请在 OBS 核对音画后开始推流。</small>
                </section>
              </div>
              {task === 'check' &&
              production?.mode === 'preparation' &&
              !cs2.status?.pending &&
              !cs2.phase &&
              (!window.__TAURI_INTERNALS__ || cs2.status !== null) ? (
                <AutomaticPreparation />
              ) : null}
            </section>
            <section hidden={task !== 'finish' || selecting} aria-label="恢复与收尾工作区">
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
