import type { OperatorPayload } from '@mizar/protocol/operator';
import type { ProgramPayload } from '@mizar/protocol/program';
import { buildMatchHeaderPresentation } from '../program/widgets/match-header/presentation';

export function workspaceMatchScore(program: ProgramPayload | null) {
  if (program?.status.telemetry !== 'fresh') return null;
  return buildMatchHeaderPresentation(program);
}

export function workspaceCurrentPov(program: ProgramPayload | null): string | null {
  if (
    program?.status.telemetry !== 'fresh' ||
    program.status.identity === 'mismatch' ||
    program.observedPlayerSourceId === null
  )
    return null;
  const player = program.players.find(
    (candidate) =>
      candidate.sourcePlayerId === program.observedPlayerSourceId &&
      candidate.lineupEvidence === 'current',
  );
  const displayName = player?.displayName?.trim();
  return displayName ? displayName : null;
}

export interface WorkspaceIssue {
  readonly id: string;
  readonly summary: string;
  readonly detail: string;
  readonly action: string;
  readonly path: string;
}

export function workspaceIssues(operator: OperatorPayload | null): WorkspaceIssue[] {
  if (!operator)
    return [
      {
        id: 'service',
        summary: '本地制播服务尚未连接',
        detail: '请确认 Mizar 本地服务正在运行，连接恢复后会自动重新检查。',
        action: '检查服务',
        path: '/debug',
      },
    ];
  const issues: WorkspaceIssue[] = [];
  const rosterRecovery =
    operator.matchContext.origin === 'online' || operator.matchContext.cachedFrom === 'online'
      ? '在比赛资料页打开 RivalHub 修改名单，返回后重新加载比赛资料。'
      : '在比赛资料页确认名单后保存。';
  const identityCodes = new Set(operator.identity.issues.map((issue) => issue.code));
  const seriesNeedsOperator = operator.seriesProgress?.bindingState === 'needs_operator';
  // Series issues retain history across recovery; only current identity evidence
  // proves a live map mismatch. The binding state still exposes other blockers.
  const mapMismatch = identityCodes.has('map_mismatch');
  if (mapMismatch)
    issues.push({
      id: 'map',
      summary: '地图不一致',
      detail: '当前游戏地图与本场地图计划不一致。核对所选比赛、地图与 BP，并在 CS2 进入对应地图。',
      action: '核对地图',
      path: '/matches?tab=maps',
    });
  else if (seriesNeedsOperator)
    issues.push({
      id: 'series',
      summary: '地图执行待确认',
      detail:
        '地图顺序、上一图结果或执行绑定尚未确认。先核对本场地图与 BP，保留已观测比分；不要为继续制作重置比赛资料。',
      action: '核对地图',
      path: '/matches?tab=maps',
    });
  const rosterIncomplete = identityCodes.has('roster_incomplete');
  const steam64Missing = identityCodes.has('missing_canonical_steam64');
  const rosterAmbiguous =
    identityCodes.has('duplicate_canonical_player_id') ||
    identityCodes.has('duplicate_canonical_steam64');
  // An account absent from incomplete/ambiguous source data is not proof of
  // a player mismatch. Repair the canonical roster before checking live IDs.
  if (rosterIncomplete)
    issues.push({
      id: 'roster',
      summary: '名单不完整',
      detail: `比赛资料中至少一队的名单少于五人。补全名单及对应 Steam64 后重新核对当前选手账号。${rosterRecovery}`,
      action: '补全名单',
      path: '/matches?tab=roster',
    });
  else if (steam64Missing)
    issues.push({
      id: 'steam64',
      summary: '选手 Steam64 缺失',
      detail: `比赛名单中的选手缺少 Steam64。补全对应账号后重新核对当前选手，不按昵称猜测身份。${rosterRecovery}`,
      action: '补全名单',
      path: '/matches?tab=roster',
    });
  else if (rosterAmbiguous)
    issues.push({
      id: 'roster',
      summary: '名单不一致',
      detail: `比赛资料中的选手身份重复。修正重复身份后重新核对当前选手账号。${rosterRecovery}`,
      action: '核对名单',
      path: '/matches?tab=roster',
    });
  else if (identityCodes.has('unexpected_human_steam64'))
    issues.push({
      id: 'steam64',
      summary: '选手 Steam64 不匹配',
      detail: `观测到的选手 Steam64 不在本场名单中。核对所选比赛及选手账号；确认替补时更新比赛名单。${rosterRecovery}`,
      action: '核对名单',
      path: '/matches?tab=roster',
    });
  else if (identityCodes.has('lineup_differs_from_expected'))
    issues.push({
      id: 'roster',
      summary: '名单不一致',
      detail: `当前阵容与比赛资料中的预期首发不同。核对两队首发及替补。${rosterRecovery}`,
      action: '核对名单',
      path: '/matches?tab=roster',
    });
  else if (identityCodes.has('side_mapping_conflict'))
    issues.push({
      id: 'identity',
      summary: '比赛身份待核对',
      detail: '当前队伍阵营与比赛资料存在冲突。核对所选比赛、名单与双方阵营。',
      action: '核对名单',
      path: '/matches?tab=roster',
    });
  else if (
    operator.identity.state === 'mismatch' &&
    !mapMismatch &&
    !identityCodes.has('unexpected_human_steam64')
  )
    issues.push({
      id: 'identity',
      summary: '比赛身份待核对',
      detail:
        '比赛身份核验尚未恢复，当前数据不足以确认具体原因。核对所选比赛及资料，并等待完整游戏数据重新核验。',
      action: '核对比赛',
      path: '/matches',
    });
  if (operator.runtime.telemetryFreshness === 'stale')
    issues.push({
      id: 'gsi',
      summary: '比赛数据已中断',
      detail:
        '当前没有新鲜游戏数据。确认 CS2 仍在观战，并检查 GSI 接收；数据中断不代表游戏已退出。',
      action: '检查游戏连接',
      path: '/settings?tab=gsi',
    });
  if (operator.matchContext.freshness === 'stale')
    issues.push({
      id: 'context',
      summary: '比赛资料使用缓存',
      detail: '当前比赛资料来自缓存。核对比赛选择与资料来源，连接恢复后重新加载最新资料。',
      action: '核对比赛',
      path: '/matches',
    });
  return issues;
}
