import type { ProjectionBundle } from '../projections/projection-coordinator.js';
import type { ProgramSceneController } from './controller.js';
import type { ObsStatus } from '../obs/adapter.js';
import { obsSceneName } from '../obs/desired-state.js';
import { obsFindingReadiness } from '../obs/prepare-readiness.js';

export function obsReadiness(
  status: ObsStatus | undefined,
  active: Parameters<typeof obsSceneName>[0],
) {
  const { blockingFindings, warnings } = obsFindingReadiness(status?.findings ?? []);
  const ready =
    status?.connection === 'connected' &&
    status.currentScene === obsSceneName(active) &&
    blockingFindings.length === 0;
  const reason =
    status?.connection === 'connected'
      ? (blockingFindings[0]?.message ??
        (status.currentScene === obsSceneName(active) ? '已就绪' : '当前场景与播出场景不一致'))
      : status?.connection === 'password_required'
        ? '需要密码'
        : status?.connection === 'invalid_password'
          ? '密码无效'
          : '等待连接';
  return {
    id: 'obs',
    attention: Boolean(
      !ready &&
      status &&
      (status.connection === 'connected' ||
        status.connection === 'password_required' ||
        status.connection === 'invalid_password' ||
        status.facts?.executable === 'not_found' ||
        (status.facts?.listener === 'refused' && status.facts.process === 'running')),
    ),
    label: 'OBS',
    ready,
    reason,
    href: '/settings?tab=obs',
    action: ready ? null : '检查 OBS 连接与配置',
    blockingFindings,
    warnings,
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
    id: string,
    label: string,
    ready: boolean,
    reason: string,
    href: string,
    action: string | null = null,
  ) => ({
    id,
    label,
    ready,
    attention: !ready && action !== null,
    reason: ready ? '已就绪' : reason,
    href,
    action: ready ? null : action,
  });
  return [
    item('match', '比赛资料', operator.matchContext.summary !== null, '选择或创建比赛', '/matches'),
    item(
      'gameplay',
      '比赛画面',
      scenes.available.includes('gameplay'),
      scenes.blocked.gameplay ?? '等待比赛数据',
      '/settings?tab=gsi',
    ),
    item(
      'radar',
      '雷达',
      radar.telemetryFreshness === 'fresh' && radar.mapName !== null && radar.players.length > 0,
      '等待地图与选手位置',
      '/settings?tab=gsi',
    ),
    item(
      'matchup',
      '对阵画面',
      scenes.available.includes('matchup'),
      scenes.blocked.matchup ?? '等待比赛资料',
      '/matches?tab=roster',
    ),
    item('bp', 'BP 画面', scenes.available.includes('bp'), '等待 BP', '/matches?tab=maps'),
    item(
      'identity',
      '选手身份',
      operator.identity.state === 'matched',
      '名单待确认',
      '/matches?tab=roster',
      ['mismatch', 'degraded'].includes(operator.identity.state) ? '核对当前首发与比赛名单' : null,
    ),
    item(
      'game-data',
      '游戏连接',
      operator.runtime.telemetryFreshness === 'fresh',
      operator.runtime.telemetryFreshness === 'stale' ? '数据已中断' : '等待实时数据',
      '/settings?tab=gsi',
      operator.runtime.telemetryFreshness === 'stale' ? '检查游戏连接' : null,
    ),
    obsReadiness(obs, scenes.active),
  ];
}
