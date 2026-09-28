import type { ProjectionBundle } from '../projections/projection-coordinator.js';
import type { ProgramSceneController } from './controller.js';
import type { ObsStatus } from '../obs/adapter.js';
import { obsSceneName } from '../obs/desired-state.js';

export function obsReadiness(
  status: ObsStatus | undefined,
  active: Parameters<typeof obsSceneName>[0],
) {
  const ready =
    status?.connection === 'connected' &&
    status.currentScene === obsSceneName(active) &&
    status.findings.length === 0;
  const reason =
    status?.connection === 'connected'
      ? (status.findings[0]?.message ??
        (status.currentScene === obsSceneName(active) ? '已就绪' : '当前场景与播出场景不一致'))
      : status?.connection === 'password_required'
        ? '需要密码'
        : status?.connection === 'invalid_password'
          ? '密码无效'
          : '等待连接';
  return {
    label: 'OBS',
    ready,
    reason,
    href: '/settings?tab=obs',
    action: ready ? null : '检查 OBS 连接与配置',
  };
}

/** One capability read model for Preparation; no new runtime state or duplicated eligibility. */
export function productionReadiness(
  bundle: ProjectionBundle,
  scenes: ReturnType<ProgramSceneController['get']>,
  obs?: ObsStatus,
) {
  const { operator, radar } = bundle;
  const item = (
    label: string,
    ready: boolean,
    reason: string,
    href: string,
    action: string | null = null,
  ) => ({
    label,
    ready,
    reason: ready ? '已就绪' : reason,
    href,
    action: ready ? null : action,
  });
  return [
    item(
      '比赛上下文',
      operator.matchContext.summary !== null,
      '选择或创建比赛',
      '/matches',
      '选择或创建比赛',
    ),
    item(
      '比赛画面',
      scenes.available.includes('gameplay'),
      scenes.blocked.gameplay ?? '等待比赛数据',
      '/settings?tab=gsi',
    ),
    item(
      '雷达',
      radar.telemetryFreshness === 'fresh' && radar.mapName !== null && radar.players.length > 0,
      '等待地图与选手位置',
      '/settings?tab=gsi',
    ),
    item(
      '对阵画面',
      scenes.available.includes('matchup'),
      scenes.blocked.matchup ?? '等待比赛资料',
      '/matches?tab=roster',
    ),
    item('BP 画面', scenes.available.includes('bp'), '等待 BP', '/matches?tab=maps'),
    item(
      '选手身份',
      operator.identity.state === 'matched',
      '名单待确认',
      '/matches?tab=roster',
      ['mismatch', 'degraded'].includes(operator.identity.state) ? '核对当前首发与比赛名单' : null,
    ),
    item(
      'CS2 / GSI',
      operator.runtime.telemetryFreshness === 'fresh',
      operator.runtime.telemetryFreshness === 'stale' ? '数据已中断' : '等待实时数据',
      '/settings?tab=gsi',
      operator.matchContext.summary !== null ? '检查 CS2 与 GSI' : null,
    ),
    obsReadiness(obs, scenes.active),
  ];
}
