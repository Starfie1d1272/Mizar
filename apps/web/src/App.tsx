import { BpPage } from './bp/BpPage';
import { OperatorShell } from './operator/OperatorShell';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';

import {
  formatDebugJson,
  numberValue,
  parseDebugRuntimeResponse,
  recordValue,
  stringValue,
  type DebugFreshness,
  type DebugRuntimeResponse,
} from './debug/runtime';
import { useBrowserHostDiagnostics } from './debug/host-diagnostics';
import { ProgramCueRendererBridge } from './program/ProgramCueRendererBridge';
import { RadarVisualFixturePage } from './program/testing/RadarVisualFixturePage';
import { ProgramPage } from './program/ProgramPage';
import { OperatorPage } from './operator/OperatorPage';
import { HudConsolePage } from './operator/HudConsolePage';
import { useHudConfigClient } from './realtime/hud-config-client';
import {
  ProgramVisualFixtureNotFound,
  ProgramVisualFixturePage,
} from './program/testing/ProgramVisualFixturePage';
import {
  createProgramCueClient,
  type LocalChannelClient,
  type LocalChannelConnectionState,
  useLocalChannelClient,
} from './realtime';
import type { LocalSnapshotChannel } from '@rivalhub-broadcast/protocol/version';

export const surfaceDefinitions = [
  {
    id: 'program',
    path: '/program',
    title: '播出画面',
    description: '透明 1920×1080 节目画布，用于承载播出画面图形。',
    realtimeChannel: 'program',
  },
  {
    id: 'operator',
    path: '/operator',
    title: '制作控制',
    description: '本地制作控制入口；当前提供实时通道与运行状态基础。',
    realtimeChannel: 'operator',
  },
  {
    id: 'debug',
    path: '/debug',
    title: '运行诊断',
    description: '查看本地制播服务当前的输入、归一化结果、运行状态与退化信号。',
    realtimeChannel: null,
  },
  {
    id: 'bp',
    path: '/operator/bp',
    title: 'BP 制作',
    description: '本地 BP 编写、比赛上下文和 Veto 播出控制。',
    realtimeChannel: null,
  },
  {
    id: 'hud',
    path: '/operator/hud',
    title: 'HUD 编辑器',
    description: '编辑并预览 Gameplay HUD 的预设与布局。',
    realtimeChannel: null,
  },
] as const;

export type SurfaceDefinition = (typeof surfaceDefinitions)[number];

export function surfaceForPath(pathname: string): SurfaceDefinition | undefined {
  return surfaceDefinitions.find(
    (surface) => surface.path === (pathname === '/' ? '/operator' : pathname),
  );
}

function connectionStateLabel(state: LocalChannelConnectionState): string {
  switch (state) {
    case 'idle':
      return '未启动';
    case 'connecting':
      return '正在连接';
    case 'awaiting-baseline':
      return '等待初始状态';
    case 'live':
      return '已连接';
    case 'reconnecting':
      return '正在重连';
    case 'protocol-error':
      return '协议不兼容';
    case 'closed':
      return '已关闭';
  }
}

function recorderStateLabel(state: string | undefined): string {
  switch (state) {
    case 'recording':
      return '正在记录';
    case 'degraded':
      return '已降级';
    case 'failed':
      return '故障';
    case 'finalizing':
      return '正在收尾';
    case 'closed':
      return '已关闭';
    default:
      return '未知';
  }
}

function useLocalChannelConnection<C extends LocalSnapshotChannel>(
  channel: C,
): LocalChannelClient<C> {
  return useLocalChannelClient(channel);
}

function SurfaceConnectionMarker({ channel }: { readonly channel: LocalSnapshotChannel }) {
  const client = useLocalChannelConnection(channel);
  const snapshot = useSyncExternalStore(client.subscribe, client.getSnapshot, client.getSnapshot);

  return (
    <p
      className="shell__realtime"
      data-connection-state={snapshot.state}
      data-local-channel={channel}
    >
      本地实时连接 · {connectionStateLabel(snapshot.state)}
    </p>
  );
}

function ProgramRoute() {
  const radarClient = useLocalChannelConnection('radar');
  const programClient = useLocalChannelConnection('program');
  const programConnection = useSyncExternalStore(
    programClient.subscribe,
    programClient.getSnapshot,
    programClient.getSnapshot,
  );
  const hudConfig = useHudConfigClient(import.meta.env.VITE_VISUAL_FIXTURES !== '1');
  const cueClient = useMemo(
    () =>
      createProgramCueClient({
        getProgramSnapshot: () => programClient.getSnapshot().current,
      }),
    [programClient],
  );
  useEffect(() => {
    const observeProgramSnapshot = () =>
      cueClient.observeProgramSnapshot(programClient.getSnapshot().current);
    observeProgramSnapshot();
    const unsubscribe = programClient.subscribe(observeProgramSnapshot);
    cueClient.start();
    return () => {
      unsubscribe();
      cueClient.dispose();
    };
  }, [cueClient, programClient]);

  return (
    <ProgramCueRendererBridge client={cueClient}>
      <ProgramPage
        radarClient={radarClient}
        connectionState={programConnection.state}
        resolvedPreset={hudConfig.current}
        snapshot={programConnection.current}
      />
    </ProgramCueRendererBridge>
  );
}

export function SurfacePage({ surface }: { readonly surface: SurfaceDefinition }) {
  return (
    <main className="shell" data-surface={surface.id}>
      <header className="shell__header">
        <p className="shell__eyebrow">RivalHub Broadcast</p>
        <h1>{surface.title}</h1>
        <p>{surface.description}</p>
      </header>

      <nav aria-label="制播页面" className="shell__nav">
        {surfaceDefinitions.map((definition) => (
          <a
            aria-current={definition.path === surface.path ? 'page' : undefined}
            href={definition.path}
            key={definition.path}
          >
            {definition.title}
          </a>
        ))}
      </nav>

      {surface.realtimeChannel === null ? null : (
        <SurfaceConnectionMarker channel={surface.realtimeChannel} />
      )}
      <p className="shell__note">当前页面只展示已实现的本地实时连接与基础运行能力。</p>
    </main>
  );
}

type DebugFetchState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly data: DebugRuntimeResponse }
  | { readonly kind: 'error'; readonly message: string };

const DEBUG_POLL_INTERVAL_MS = 1_000;

function freshnessLabel(freshness: DebugFreshness): string {
  switch (freshness) {
    case 'fresh':
      return '正常';
    case 'stale':
      return '已过期';
    case 'awaiting':
      return '等待 GSI 数据';
  }
}

function userVisibleDebugError(error: unknown): string {
  if (error instanceof Error && error.message.startsWith('本地制播服务返回 HTTP ')) {
    return error.message;
  }
  if (error instanceof Error && error.message === '响应结构无法识别') return error.message;
  return '无法连接本地制播服务';
}

function useDebugRuntime(): DebugFetchState {
  const [state, setState] = useState<DebugFetchState>({ kind: 'loading' });

  useEffect(() => {
    let active = true;
    let timer: number | undefined;

    const poll = async (): Promise<void> => {
      try {
        const response = await fetch('/debug/runtime', {
          headers: { Accept: 'application/json' },
        });
        if (!response.ok) throw new Error(`本地制播服务返回 HTTP ${response.status}`);
        const parsed = parseDebugRuntimeResponse(await response.json());
        if (parsed === undefined) throw new Error('响应结构无法识别');
        if (active) setState({ kind: 'ready', data: parsed });
      } catch (error: unknown) {
        if (active) {
          setState({ kind: 'error', message: userVisibleDebugError(error) });
        }
      } finally {
        if (active) timer = window.setTimeout(() => void poll(), DEBUG_POLL_INTERVAL_MS);
      }
    };

    void poll();
    return () => {
      active = false;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, []);

  return state;
}

function DebugMetric({
  label,
  value,
  note,
  tone = 'neutral',
}: {
  readonly label: string;
  readonly value: string;
  readonly note: string;
  readonly tone?: 'neutral' | 'signal' | 'warning';
}) {
  return (
    <article className="debug-metric" data-tone={tone}>
      <span className="debug-metric__label">{label}</span>
      <strong>{value}</strong>
      <span className="debug-metric__note">{note}</span>
    </article>
  );
}

function DebugEvidencePanel({
  eyebrow,
  title,
  value,
  tone = 'neutral',
}: {
  readonly eyebrow: string;
  readonly title: string;
  readonly value: unknown;
  readonly tone?: 'neutral' | 'signal' | 'warning';
}) {
  return (
    <article className="debug-panel" data-tone={tone}>
      <header className="debug-panel__header">
        <span>{eyebrow}</span>
        <h2>{title}</h2>
      </header>
      <pre className="debug-panel__body">{formatDebugJson(value)}</pre>
    </article>
  );
}

function DebugContent({
  data,
  hosts,
}: {
  readonly data: DebugRuntimeResponse;
  readonly hosts: ReturnType<typeof useBrowserHostDiagnostics>;
}) {
  const runtime = data.runtime.current;
  const map = recordValue(runtime, 'map');
  const recorder = data.recorderHealth;
  const mapName = stringValue(map, 'name') ?? '未建立';
  const statusTone = data.freshness === 'fresh' ? 'signal' : 'warning';
  const deliveryFailed = data.deliveryHealth.some(
    (health) => (numberValue(health, 'failed') ?? 0) > 0,
  );

  return (
    <>
      <section aria-label="运行状态概览" className="debug-metrics">
        <DebugMetric label="本地制播服务" note="诊断连接正常" tone="signal" value="已连接" />
        <DebugMetric
          label="比赛数据"
          note={data.freshness === 'stale' ? '请检查 CS2 与 GSI 连接' : '等待或接收当前比赛遥测'}
          tone={statusTone}
          value={freshnessLabel(data.freshness)}
        />
        <DebugMetric label="当前地图" note="播出数据来源" value={mapName} />
        <DebugMetric
          label="数据来源"
          note="CS2 游戏状态集成"
          value={data.raw.current === null ? '等待 GSI 输入' : 'GSI'}
        />
        <DebugMetric
          label="采集记录"
          note="详细信息见高级技术信息"
          value={recorderStateLabel(stringValue(recorder, 'state'))}
        />
        <DebugMetric
          label="状态投递"
          tone={deliveryFailed ? 'warning' : 'neutral'}
          note="详细投递记录见高级技术信息"
          value={
            deliveryFailed
              ? '有投递失败记录'
              : data.deliveryHealth.length === 0
                ? '尚无消费者'
                : '投递正常'
          }
        />
        <DebugMetric
          label="OBS 浏览器源"
          note={
            hosts === null
              ? '正在读取本地连接状态'
              : hosts.active.obsVersions.length > 0
                ? `识别版本 ${hosts.active.obsVersions.join('、')}`
                : '按浏览器连接标识统计通道'
          }
          value={
            hosts === null
              ? '暂不可用'
              : hosts.active.obs === 0
                ? '未连接'
                : `已连接 ${hosts.active.obs} 个通道`
          }
        />
        <DebugMetric
          label="普通浏览器"
          note="按本地实时通道连接数统计"
          value={
            hosts === null
              ? '暂不可用'
              : hosts.active.browser === 0
                ? '未连接'
                : `已连接 ${hosts.active.browser} 个通道`
          }
        />
        <DebugMetric
          label="未识别连接"
          note="浏览器未提供可识别标识时会归入此项"
          value={hosts === null ? '暂不可用' : `${hosts.active.unknown} 个通道`}
        />
      </section>
      <details className="debug-advanced">
        <summary>高级技术信息</summary>
        <section className="debug-evidence-grid" aria-label="当前证据">
          <DebugEvidencePanel
            eyebrow="01 / 接收入口"
            title="已接收原始数据"
            tone="signal"
            value={data.raw.current}
          />
          <DebugEvidencePanel
            eyebrow="02 / 适配层"
            title="标准化观测"
            value={data.normalized.current}
          />
          <DebugEvidencePanel
            eyebrow="03 / 运行核心"
            title="当前运行状态"
            value={data.runtime.current}
          />
        </section>

        <section className="debug-lower-grid" aria-label="运行诊断">
          <DebugEvidencePanel
            eyebrow="04 / 连续性"
            title="近期状态切换"
            value={data.recentTransitions}
          />
          <DebugEvidencePanel
            eyebrow="05 / 健康状态"
            title="记录与投递"
            value={{ recorder: data.recorderHealth, delivery: data.deliveryHealth }}
          />
          <DebugEvidencePanel
            eyebrow="06 / 诊断"
            title="最近一批适配诊断"
            tone={data.latestGsiDiagnostics === null ? 'neutral' : 'warning'}
            value={data.latestGsiDiagnostics}
          />
          <DebugEvidencePanel
            eyebrow="07 / 本地服务"
            title="近期运行诊断"
            tone={data.recentRuntimeDiagnostics.length === 0 ? 'neutral' : 'warning'}
            value={data.recentRuntimeDiagnostics}
          />
          <DebugEvidencePanel
            eyebrow="08 / 浏览器接入"
            title="连接与重连记录"
            value={
              hosts === null
                ? '当前无法读取浏览器连接诊断'
                : {
                    totals: hosts.totals,
                    recentEvents: hosts.recentEvents.map((event) => ({
                      at: event.at,
                      state: event.action === 'connected' ? '已连接' : '已断开',
                      host:
                        event.host === 'obs'
                          ? 'OBS 浏览器源'
                          : event.host === 'browser'
                            ? '普通浏览器'
                            : '未识别连接',
                      channel:
                        event.channel === 'program-cue'
                          ? '播出提示'
                          : event.channel === 'program'
                            ? '播出画面'
                            : event.channel === 'radar'
                              ? 'Radar'
                              : event.channel === 'operator'
                                ? '制作控制'
                                : '辅助信息',
                      ...(event.obsVersion === undefined ? {} : { obsVersion: event.obsVersion }),
                    })),
                  }
            }
          />
        </section>

        <p className="debug-footer-note">
          运行实例 <code>{data.producerInstanceId ?? '未创建'}</code>
          <span aria-hidden="true"> · </span>
          原始数据、标准化数据与运行状态均只保留当前有界证据；此页面不保存历史快照。
        </p>
      </details>
    </>
  );
}

export function DebugPage() {
  const state = useDebugRuntime();
  const hosts = useBrowserHostDiagnostics();

  return (
    <OperatorShell active="/debug">
      <main className="debug-shell" data-surface="debug">
        <header className="debug-header">
          <div className="debug-header__signal" aria-hidden="true">
            <span>本地</span>
            <i />
            <span>运行</span>
          </div>
          <div>
            <p className="debug-eyebrow">RivalHub Broadcast / 运行诊断</p>
            <h1>运行诊断</h1>
            <p className="debug-intro">检查数据接入与记录状态；排查问题时展开高级技术信息。</p>
          </div>
        </header>

        {state.kind === 'loading' ? (
          <section className="debug-state" aria-live="polite">
            <span className="debug-state__mark">…</span>
            <div>
              <h2>正在连接本地制播服务</h2>
              <p>等待第一份诊断快照。</p>
            </div>
          </section>
        ) : null}

        {state.kind === 'error' ? (
          <section className="debug-state debug-state--error" role="alert">
            <span className="debug-state__mark">!</span>
            <div>
              <h2>本地制播服务暂不可用</h2>
              <p>{state.message}。页面会继续每秒重试。</p>
            </div>
          </section>
        ) : null}

        {state.kind === 'ready' ? <DebugContent data={state.data} hosts={hosts} /> : null}
      </main>
    </OperatorShell>
  );
}

export function App() {
  const pathname = window.location.pathname;
  if (pathname === '/qualification')
    return (
      <OperatorShell active="/qualification">
        <main className="operator-shell">
          <header className="product-heading">
            <h1>现场验收</h1>
            <p>当前服务未开启现场验收模式。</p>
          </header>
          <section className="operator-panel">
            <h2>准备现场验收</h2>
            <p>
              请使用现场验收包的启动脚本运行验收服务，再访问此页面。验收需要真实 Windows、CS2 与 OBS
              环境。
            </p>
            <p>普通制作模式不会自动开启验收记录。</p>
            <a href="/operator">返回制作控制</a>
          </section>
        </main>
      </OperatorShell>
    );
  const radarRoute = /^\/__visual\/radar\/([^/]+)\/?$/.exec(pathname);
  if (radarRoute && import.meta.env.DEV && import.meta.env.VITE_VISUAL_FIXTURES === '1')
    return <RadarVisualFixturePage id={radarRoute[1]!} />;
  const visualRoute = /^\/__visual\/program\/([^/]+)\/?$/.exec(pathname);
  const isVisualPath =
    pathname === '/__visual/program' || pathname.startsWith('/__visual/program/');

  if (isVisualPath) {
    if (!import.meta.env.DEV || import.meta.env.VITE_VISUAL_FIXTURES !== '1') {
      return <ProgramVisualFixtureNotFound fixtureId={visualRoute?.[1] ?? null} />;
    }
    const fixtureId = visualRoute?.[1];
    return fixtureId === undefined ? (
      <ProgramVisualFixtureNotFound fixtureId={null} />
    ) : (
      <ProgramVisualFixturePage fixtureId={fixtureId} />
    );
  }

  if (pathname === '/program/bp') return <BpPage />;
  if (pathname === '/operator/bp') return <BpPage operator />;
  const surface = surfaceForPath(pathname);
  if (surface === undefined)
    return (
      <OperatorShell active="">
        <main className="operator-shell">
          <header className="product-heading">
            <h1>页面不存在</h1>
            <p>404 · 请检查地址，或返回制作控制继续操作。</p>
          </header>
          <div className="dashboard-links">
            <a href="/operator">返回制作控制</a>
          </div>
        </main>
      </OperatorShell>
    );
  if (surface.id === 'debug') return <DebugPage />;
  if (surface.id === 'program') return <ProgramRoute />;
  if (surface.id === 'operator') return <OperatorPage />;
  if (surface.id === 'hud') return <HudConsolePage />;
  return <SurfacePage surface={surface} />;
}
