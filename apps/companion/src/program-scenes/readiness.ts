import type { ProjectionBundle } from '../projections/projection-coordinator.js';
import type { ProgramSceneController } from './controller.js';

/** One capability read model for Preparation; no new runtime state or duplicated eligibility. */
export function productionReadiness(
  bundle: ProjectionBundle,
  scenes: ReturnType<ProgramSceneController['get']>,
) {
  const { operator, radar } = bundle;
  const item = (label: string, ready: boolean, reason: string, href: string) => ({
    label,
    ready,
    reason: ready ? '已就绪' : reason,
    href,
  });
  return [
    item('比赛上下文', operator.matchContext.summary !== null, '选择或创建比赛', '/matches'),
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
    item('选手身份', operator.identity.state === 'matched', '名单待确认', '/matches?tab=roster'),
    item(
      'CS2 / GSI',
      operator.runtime.telemetryFreshness === 'fresh',
      operator.runtime.telemetryFreshness === 'stale' ? '数据已中断' : '等待实时数据',
      '/settings?tab=gsi',
    ),
  ];
}
