export type SyncHealth = {
  status: 'inactive' | 'stopped' | 'other_device' | 'waiting' | 'healthy' | 'attention';
  reason: string | null;
  incidentId: string | null;
  deviceName: string | null;
};

export function syncHealthText(health?: SyncHealth): string {
  if (!health) return '网站接收待确认';
  if (health.status === 'healthy') return '网站正在接收本场数据';
  if (health.status === 'stopped') return '本机网站同步已停止';
  if (health.status === 'other_device')
    return `当前由 ${health.deviceName ?? '其他设备'} 同步本场数据`;
  if (health.status === 'inactive' && !health.reason) return '尚未开启本场网站同步';
  if (health.status === 'waiting') return '等待网站接收本场数据';
  switch (health.reason) {
    case 'authorization_expired':
      return '网站授权已失效，请重新连接';
    case 'permission_denied':
      return '网站未授权本机同步，请核对权限';
    case 'reliable_needs_attention':
      return '网站已记录本场数据，但比赛状态需要核对。';
    case 'continuity_chain_missing':
      return '本场比赛进度记录不完整，请核对比赛进度并导出诊断。';
    case 'continuity_waiting':
      return '正在等待网站确认本场比赛进度。';
    case 'context_refreshing':
      return '正在刷新比赛资料。';
    case 'context_reconfirming':
      return '比赛资料已刷新，正在等待新比赛数据重新确认。';
    case 'context_recovery_blocked':
      return '本场资料或同步设备需要核对，请检查本场比赛。';
    case 'context_conflict':
    case 'context_stale':
      return '比赛资料需要刷新并确认；等待新比赛数据。';
    case 'sequence_stale':
      return '网站记录的比赛进度与本机不一致，请核对本场比赛。';
    case 'generation_fence':
    case 'epoch_fence':
      return '网站尚未确认本场比赛进度，请核对当前比赛。';
    case 'authority_changed':
      return '网站已更换同步设备，请核对本场比赛。';
    case 'idempotency_conflict':
    case 'invalid_schema':
      return '网站拒绝了本场数据，请导出诊断并核对网站状态。';
    case 'source_unavailable':
      return '本机尚未开启本场网站同步';
    case 'map_start_pending':
      return '网站正在确认本图开局';
    case 'map_start_rejected':
      return '网站未接受本图开局，请核对网站状态并导出诊断。';
    case 'http_400':
      return '网站未接受本场数据，请导出诊断。';
    case 'network_failed':
    case 'timeout':
      return '网站同步连接未完成，请检查网络后重试';
    case 'input_unavailable':
      return '当前比赛数据不可用，请检查游戏连接与比赛资料';
    default:
      return '网站尚未确认接收本场数据';
  }
}
