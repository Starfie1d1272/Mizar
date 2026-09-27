import type { BpSnapshot } from '@rivalhub-broadcast/protocol/bp';
import type { OperatorPayload } from '@rivalhub-broadcast/protocol/operator';

export type WorkspacePhase = 'pre_match' | 'bp' | 'live' | 'map_end' | 'match_end';

export function workspacePhase(
  operator: OperatorPayload | null,
  bp: BpSnapshot | null,
): WorkspacePhase {
  if (bp && bp.state !== 'hidden' && bp.projection) return 'bp';
  if (operator?.runtime.telemetryFreshness === 'fresh' && operator.runtime.mapName) return 'live';
  const series = operator?.seriesProgress;
  if (series && (series.score.a >= series.requiredWins || series.score.b >= series.requiredWins))
    return 'match_end';
  if (series?.maps.some((map) => map.status === 'completed')) return 'map_end';
  return 'pre_match';
}

export function workspaceIssues(operator: OperatorPayload | null): string[] {
  if (!operator) return ['本地制播服务尚未连接'];
  const issues: string[] = [];
  if (operator.runtime.telemetryFreshness === 'stale')
    issues.push('比赛数据已中断，请检查 CS2 与 GSI。');
  if (operator.seriesProgress?.bindingState === 'needs_operator')
    issues.push('当前地图需要确认绑定。');
  if (operator.identity.state === 'mismatch') issues.push('选手与当前比赛不一致。');
  if (operator.matchContext.freshness === 'stale') issues.push('比赛绑定使用缓存信息，请核对。');
  return issues;
}
