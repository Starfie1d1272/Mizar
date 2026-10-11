import { canonicalizeCs2MapName } from '@mizar/core/map-name';
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
  readonly run?: 'refresh-rivalhub';
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
  const authority = operator.matchContext.rosterAuthority ?? 'unknown';
  const localRoster = authority === 'local-server';
  const rosterAction = localRoster
    ? '识别服务器首发'
    : authority === 'rivalhub'
      ? '核对网站名单'
      : '核对名单';
  const rosterRecovery = localRoster
    ? '先确认正在观战的服务器正确，再从当前服务器识别首发，核对两队后确认保存。'
    : authority === 'rivalhub'
      ? '在比赛资料页打开网站本场工作台，由赛务人员修改名单，返回后刷新比赛资料。'
      : '核对资料来源与当前上场账号，不自动覆盖名单。';
  const serverRosterReady =
    operator.runtime.telemetryFreshness === 'fresh' &&
    operator.activeLineup?.state === 'complete' &&
    operator.activeLineup.retainedCount === 0;
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
  else if (seriesNeedsOperator) {
    const actualMap =
      operator.runtime.mapName === null ? null : canonicalizeCs2MapName(operator.runtime.mapName);
    const matching = operator.seriesProgress!.maps.filter(
      (map) => (map.status === 'pending' || map.status === 'current') && map.mapName === actualMap,
    );
    issues.push(
      matching.length > 0
        ? {
            id: 'series',
            summary:
              matching.length === 1
                ? `当前图尚未确认为第 ${matching[0]!.mapOrder} 图`
                : '当前是第几图待确认',
            detail:
              '当前游戏地图存在可用比赛位置，需要人工确认。在地图页选择当前属于第几图并确认；已有比分保留，缺失的上一图结果不会因此补齐。',
            action: '确认当前图',
            path: '/matches?tab=maps',
          }
        : {
            id: 'series',
            summary: '当前地图没有可用比赛位置',
            detail:
              '可能存在未结束的上一图、重复已完成地图、图池或图数冲突。当前功能不能新增比赛位置或补录历史赛果；保留资料和游戏观测，导出诊断反馈。',
            action: '导出诊断反馈',
            path: '/debug',
          },
    );
  }
  const unfinished = operator.seriesProgress?.maps.find((map) => map.status === 'current');
  const resultBlocked =
    unfinished &&
    operator.seriesProgress?.issues.some(
      (issue) =>
        issue.mapEpoch === unfinished.executionMapEpoch &&
        issue.mapOrder === unfinished.mapOrder &&
        ['final_score_unavailable', 'final_score_conflict', 'side_mapping_unproven'].includes(
          issue.code,
        ),
    );
  if (!seriesNeedsOperator && resultBlocked)
    issues.push({
      id: 'result',
      summary: '本图结果尚未确认',
      detail:
        '地图结束数据缺少可核验的比分或双方身份。恢复完整游戏观测后会重新检查；确认地图位置不能补录结果，无法恢复观测时请保留记录并导出诊断反馈。',
      action: '导出诊断反馈',
      path: '/debug',
    });
  const rosterIncomplete = identityCodes.has('roster_incomplete');
  // The identity owner identifies the affected expected starter. Map mismatch
  // or incomplete observations cannot turn an unused bench record into one.
  const steam64Missing = operator.identity.issues.some(
    (issue) => issue.code === 'missing_canonical_steam64' && issue.affectsExpectedLineup === true,
  );
  const steam64MissingUnscoped = operator.identity.issues.some(
    (issue) => issue.code === 'missing_canonical_steam64' && issue.affectsExpectedLineup == null,
  );
  const rosterAmbiguous =
    identityCodes.has('duplicate_canonical_player_id') ||
    identityCodes.has('duplicate_canonical_steam64');
  // An account absent from incomplete/ambiguous source data is not proof of
  // a player mismatch. Repair the canonical roster before checking live IDs.
  if (rosterIncomplete && (!localRoster || serverRosterReady))
    issues.push({
      id: 'roster',
      summary: localRoster
        ? '本地首发待确认'
        : authority === 'rivalhub'
          ? '网站名单不完整'
          : '名单资料未就绪',
      detail: `比赛资料中至少一队的名单少于五人。${rosterRecovery}`,
      action: rosterAction,
      path: '/matches?tab=roster',
    });
  else if (steam64Missing && (!localRoster || serverRosterReady))
    issues.push({
      id: 'steam64',
      summary: '选手 Steam64 缺失',
      detail: `比赛资料中的预期首发缺少 Steam64。${rosterRecovery}`,
      action: rosterAction,
      path: '/matches?tab=roster',
    });
  else if (rosterAmbiguous)
    issues.push({
      id: 'roster',
      summary: '名单不一致',
      detail: `比赛资料中的选手身份重复。修正重复身份后重新核对当前选手账号。${rosterRecovery}`,
      action: rosterAction,
      path: '/matches?tab=roster',
    });
  else if (steam64MissingUnscoped && identityCodes.has('unexpected_human_steam64'))
    issues.push({
      id: 'identity',
      summary: '名单资料待核对',
      detail:
        '身份诊断未说明缺少账号的记录是否预期首发，当前资料不足以确认上场账号不匹配。核对比赛资料来源与名单，等待完整身份核验。',
      action: '核对比赛资料',
      path: '/matches',
    });
  else if (identityCodes.has('unexpected_human_steam64') && !rosterIncomplete && !steam64Missing)
    issues.push({
      id: 'steam64',
      summary: '选手 Steam64 不匹配',
      detail: `观测到的选手 Steam64 不在本场名单中。先核对比赛与服务器是否正确，再确认替补或名单变化。${rosterRecovery}`,
      action: rosterAction,
      path: '/matches?tab=roster',
    });
  else if (identityCodes.has('lineup_differs_from_expected'))
    issues.push({
      id: 'roster',
      summary: '名单不一致',
      detail: `当前阵容与比赛资料中的预期首发不同。核对两队首发及替补。${rosterRecovery}`,
      action: rosterAction,
      path: '/matches?tab=roster',
    });
  else if (identityCodes.has('side_mapping_conflict'))
    issues.push({
      id: 'identity',
      summary: '比赛身份待核对',
      detail: '当前队伍阵营与比赛资料存在冲突。核对所选比赛、名单与双方阵营。',
      action: rosterAction,
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
  const failure = operator.matchContext.sourceFailure;
  if (failure) {
    const authorization = failure === 'authorization';
    const format = ['invalid_response', 'invalid_manifest', 'match_mismatch'].includes(failure);
    const unavailable = failure === 'not_found';
    issues.push({
      id: `context-${failure}`,
      summary: authorization
        ? '网站授权被拒绝'
        : format
          ? '网站比赛资料无法加载'
          : unavailable
            ? '网站比赛已不可获取'
            : '网站比赛资料更新失败',
      detail: authorization
        ? '网站拒绝当前授权。已加载资料会保留；重新连接 RivalHub 后刷新本场资料。'
        : format
          ? '网站返回的资料格式或比赛标识不符合本场要求。已加载资料会保留；刷新重试，仍失败时导出诊断反馈给赛务或维护人员。'
          : unavailable
            ? '网站未找到当前比赛。核对网站是否仍保留该比赛及你的访问权限，再选择有效比赛。'
            : failure === 'network' || failure === 'timeout'
              ? '连接网站失败或超时。检查本机网络后刷新重试；后台也会自动重试，已有比赛资料会保留。'
              : '网站当前不可用。刷新重试；持续失败时检查网站服务并导出诊断反馈，已有比赛资料会保留。',
      action: authorization ? '重新连接 RivalHub' : unavailable ? '选择有效比赛' : '重试更新资料',
      path: authorization ? '/settings?tab=rivalhub' : '/matches',
      ...(!authorization && !unavailable ? { run: 'refresh-rivalhub' as const } : {}),
    });
  }
  // Startup LKG restoration alone is normal recovery, not proof of network failure.
  return issues;
}
