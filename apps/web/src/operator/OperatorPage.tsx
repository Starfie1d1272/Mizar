import { BpDashboardControl } from '../bp/BpControls';
import { useState, useSyncExternalStore } from 'react';
import type { FormEvent } from 'react';

import { OperatorShell } from './OperatorShell';

import { type LocalChannelConnectionState, useLocalChannelClient } from '../realtime';
import { useBrowserHostDiagnostics } from '../debug/host-diagnostics';

function connectionStateLabel(state: LocalChannelConnectionState): string {
  switch (state) {
    case 'live':
      return '已连接';
    case 'connecting':
      return '正在连接';
    case 'awaiting-baseline':
      return '等待初始状态';
    case 'reconnecting':
      return '正在重连';
    case 'protocol-error':
      return '协议不兼容';
    case 'closed':
      return '已关闭';
    default:
      return '未启动';
  }
}

const MAP_STATUS = {
  pending: '待开始',
  current: '进行中',
  completed: '已结束',
  not_played: '不再进行',
} as const;
const IDENTITY_STATUS = {
  unbound: '尚未绑定比赛',
  resolving: '正在核对选手',
  matched: '选手已匹配',
  degraded: '部分身份待核对',
  mismatch: '选手与比赛不一致',
} as const;

function HealthCard({
  label,
  value,
  note,
  tone = 'neutral',
}: {
  readonly label: string;
  readonly value: string;
  readonly note: string;
  readonly tone?: string;
}) {
  return (
    <article data-tone={tone}>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{note}</small>
    </article>
  );
}

export function OperatorPage() {
  const client = useLocalChannelClient('operator');
  const hosts = useBrowserHostDiagnostics();
  const connection = useSyncExternalStore(client.subscribe, client.getSnapshot, client.getSnapshot);
  const snapshot = connection.current;
  const payload = snapshot?.payload;
  const series = payload?.seriesProgress ?? null;
  const match = payload?.matchContext.summary;
  const connected = connection.state === 'live';
  const fresh = connected && payload?.runtime.telemetryFreshness === 'fresh';
  const needsBinding = connected && series?.bindingState === 'needs_operator';
  const issues = [
    ...(series?.issues ?? []),
    ...(payload?.runtime.telemetryFreshness !== 'awaiting' || match
      ? (payload?.identity.issues ?? [])
      : []),
    ...(payload?.runtime.telemetryFreshness !== 'awaiting'
      ? (payload?.activeLineup.issues ?? [])
      : []),
    ...(payload?.matchContext.diagnostics ?? []),
  ].filter((issue) => issue.severity !== 'info');
  const [mapOrder, setMapOrder] = useState('');
  const [reason, setReason] = useState('');
  const [commandState, setCommandState] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setSubmitting(true);
    setCommandState(null);
    try {
      const response = await fetch('/operator/series/bind', {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          kind: 'bind-current-map-execution-to-series-map',
          mapOrder: Number(mapOrder),
          reason,
        }),
      });
      await response.json();
      if (!response.ok) throw new Error('地图绑定未完成');
      setCommandState('已确认当前地图绑定。');
    } catch {
      setCommandState('地图绑定未完成，请检查连接和地图计划后重试。');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <OperatorShell active="/operator">
      <main className="operator-shell dashboard" data-surface="operator">
        <header className="product-heading">
          <h1>制作控制</h1>
          <p>查看当前比赛、数据接入与播出状态。</p>
        </header>
        <div className="dashboard-workspace">
          <div className="dashboard-primary">
            <section className="dashboard-match" aria-label="当前比赛">
              <div className="dashboard-section-label">
                <span>当前比赛</span>
                <span className="dashboard-badge">{fresh ? '正在接收' : '等待接入'}</span>
              </div>
              {match ? (
                <>
                  <p className="dashboard-match__meta">
                    {match.competitionName} · {match.format.toUpperCase()}
                    {!connected ? ' · 上次接收的信息' : ''}
                  </p>
                  <div className="dashboard-match__teams">
                    <h2>{match.entryAName}</h2>
                    <strong className="dashboard-match__score">
                      {series ? `${series.score.a} : ${series.score.b}` : '— : —'}
                    </strong>
                    <h2>{match.entryBName}</h2>
                  </div>
                </>
              ) : (
                <div className="dashboard-empty">
                  <div className="dashboard-empty__signal" aria-hidden="true">
                    <span />
                    <span />
                    <span />
                    <span />
                    <span />
                  </div>
                  <h2>等待比赛接入</h2>
                  <p>
                    启动 CS2 并接入比赛数据。
                    <br />
                    你也可以先使用真实回放，调整 HUD 布局。
                  </p>
                  <a href="/operator/hud?mode=replay">
                    打开重放预览 <span aria-hidden="true">→</span>
                  </a>
                </div>
              )}
              <p className="dashboard-match__map">
                当前地图 · {payload?.runtime.mapName ?? '等待比赛数据'}
                {series?.currentMapOrder ? ` · 第 ${series.currentMapOrder} 张` : ''}
              </p>
            </section>
            <BpDashboardControl />
            {needsBinding || issues.length > 0 || !connected ? (
              <section className="dashboard-notice" aria-label="需要处理">
                <h2>需要处理</h2>
                {!connected ? <p>制作连接尚未就绪。恢复连接后会自动获取当前状态。</p> : null}
                {needsBinding ? <p>当前地图与系列赛计划无法自动对应，请核对后确认绑定。</p> : null}
                {issues.length > 0 ? (
                  <>
                    <p>比赛状态有 {issues.length} 项提示，请前往运行诊断核对数据来源与比赛信息。</p>
                    <details>
                      <summary>高级诊断详情</summary>
                      <pre>{JSON.stringify(issues, null, 2)}</pre>
                    </details>
                  </>
                ) : null}
              </section>
            ) : null}
            {series ? (
              <section aria-label="系列赛地图状态">
                <h2>地图计划</h2>
                <ol className="dashboard-map-list">
                  {series.maps.map((map) => (
                    <li key={map.mapOrder}>
                      <strong>
                        {map.mapOrder}. {map.mapName}
                      </strong>
                      <span>
                        {MAP_STATUS[map.status]}
                        {map.finalScore ? ` · ${map.finalScore.a} : ${map.finalScore.b}` : ''}
                      </span>
                    </li>
                  ))}
                </ol>
              </section>
            ) : null}
            {needsBinding ? (
              <form
                className="operator-panel operator-form"
                onSubmit={(event) => void submit(event)}
              >
                <header>
                  <h2>绑定当前地图执行</h2>
                </header>
                <label>
                  计划地图序号
                  <select
                    required
                    value={mapOrder}
                    onChange={(event) => setMapOrder(event.target.value)}
                  >
                    <option value="" disabled>
                      请选择计划地图
                    </option>
                    {series?.maps
                      .filter((map) => map.status !== 'completed' && map.status !== 'not_played')
                      .map((map) => (
                        <option value={map.mapOrder} key={map.mapOrder}>
                          {map.mapOrder}. {map.mapName}
                        </option>
                      ))}
                  </select>
                </label>
                <label>
                  确认理由
                  <textarea
                    maxLength={512}
                    onChange={(event) => setReason(event.target.value)}
                    required
                    rows={3}
                    value={reason}
                  />
                </label>
                <button
                  disabled={
                    submitting ||
                    !series?.maps.some(
                      (map) =>
                        String(map.mapOrder) === mapOrder &&
                        map.status !== 'completed' &&
                        map.status !== 'not_played',
                    )
                  }
                  type="submit"
                >
                  {submitting ? '提交中…' : '确认绑定'}
                </button>
              </form>
            ) : null}
            {commandState === null ? null : <p role="status">{commandState}</p>}
            <section className="dashboard-shortcuts" aria-label="常用工具">
              <a href="/operator/hud">
                <span className="dashboard-shortcuts__symbol" aria-hidden="true">
                  HUD
                </span>
                <div>
                  <h2>调整你的播出画面</h2>
                  <p>编辑布局、预览比赛，确认后启用。</p>
                </div>
                <span aria-hidden="true">↗</span>
              </a>
              <a href="/debug">
                <span className="dashboard-shortcuts__symbol" aria-hidden="true">
                  ⋮
                </span>
                <div>
                  <h2>检查数据与连接</h2>
                  <p>查看接入状态，定位现场问题。</p>
                </div>
                <span aria-hidden="true">↗</span>
              </a>
            </section>
          </div>
          <aside className="dashboard-health" aria-label="制作连接状态">
            <header>
              <h2>运行状态</h2>
              <span>当前连接</span>
            </header>
            <HealthCard
              label="本地制播服务"
              value={connectionStateLabel(connection.state)}
              note="制作控制实时连接"
              tone={connected ? 'good' : 'warning'}
            />
            <HealthCard
              label="比赛数据"
              value={
                !connected
                  ? '等待服务连接'
                  : fresh
                    ? '正在接收'
                    : payload?.runtime.telemetryFreshness === 'stale'
                      ? '数据已过期'
                      : '等待第一份数据'
              }
              note={fresh ? '当前遥测正常' : '请检查 CS2 与 GSI 数据接入'}
              tone={fresh ? 'good' : 'warning'}
            />
            <HealthCard
              label="播出画面"
              value={fresh ? '数据已就绪' : '等待比赛数据'}
              note="实际输出请打开播出画面检查"
              tone={fresh ? 'good' : 'neutral'}
            />
            <HealthCard
              label="比赛身份"
              value={connected && payload ? IDENTITY_STATUS[payload.identity.state] : '等待核对'}
              note={
                payload?.matchContext.freshness === 'stale'
                  ? '赛事上下文已过期，请检查数据来源'
                  : '按当前比赛名单核对选手'
              }
              tone={connected && payload?.identity.state === 'mismatch' ? 'warning' : 'neutral'}
            />
            <HealthCard
              label="场上阵容"
              value={
                connected && payload
                  ? `${payload.activeLineup.ctCount} CT / ${payload.activeLineup.tCount} T`
                  : '等待选手数据'
              }
              note={payload?.activeLineup.state === 'complete' ? '阵容完整' : '等待完整阵容证据'}
            />
            <HealthCard
              label="OBS 浏览器源"
              value={
                hosts === null
                  ? '正在读取'
                  : hosts.active.obs === 0
                    ? '尚未连接'
                    : `已连接 ${hosts.active.obs} 个通道`
              }
              note={
                hosts === null
                  ? '正在读取本地通道状态'
                  : hosts.active.obsVersions.length > 0
                    ? `识别版本 ${hosts.active.obsVersions.join('、')}；请再核对实际画面`
                    : '按连接标识统计；请再核对实际画面'
              }
            />
          </aside>
        </div>
      </main>
    </OperatorShell>
  );
}
