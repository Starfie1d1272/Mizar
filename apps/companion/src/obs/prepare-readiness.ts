import { diagnosticValue } from '../support/diagnostic-value.js';
import type { ObsFinding } from './reconcile.js';

export function obsFailureKind(
  error: unknown,
): 'authentication' | 'refused' | 'timeout' | 'unknown' {
  const value = error as { code?: unknown; message?: unknown } | null;
  const message = typeof value?.message === 'string' ? value.message.toLowerCase() : '';
  if (value?.code === 4009 || /authentication|invalid password|password required/.test(message))
    return 'authentication';
  if (value?.code === 'ECONNREFUSED' || message.includes('econnrefused')) return 'refused';
  if (/timeout|timed out|超时/.test(message)) return 'timeout';
  return 'unknown';
}

export function obsErrorEvidence(error: unknown, password = ''): unknown {
  const redact = (value: unknown): unknown => {
    if (typeof value === 'string')
      return password ? value.replaceAll(password, '[redacted]') : value;
    if (Array.isArray(value)) return value.map(redact);
    if (typeof value === 'object' && value !== null)
      return Object.fromEntries(Object.entries(value).map(([key, field]) => [key, redact(field)]));
    return value;
  };
  return redact(diagnosticValue(error, '', new Set(), password ? [password] : []));
}

export function obsAudioModeFailureEvidence(error: unknown) {
  const message = error instanceof Error ? error.message : '';
  const exactReasons = [
    'audio_desktop_choice_required',
    'audio_selection_changed',
    'audio_revision_changed',
    'audio_mode_already_desktop',
    'audio_commentary_unavailable',
    'audio_mode_pending',
    'audio_mode_target_changed',
    'audio_migration_identity_changed',
    'audio_migration_external_change',
    'audio_migration_backup_conflict',
    'audio_migration_recovery_required',
    'audio_migration_write_uncertain',
    'audio_setup_context_changed',
    'audio_configuration_timeout',
    'audio_configuration_disconnected',
    'audio_configuration_busy',
  ];
  const parameterReasons = [
    'audio_nested_shared_path',
    'audio_video_path_unresolved',
    'audio_monitor_shared',
    'audio_global_path_unresolved',
  ];
  return {
    code:
      exactReasons.find((code) => message === code) ??
      parameterReasons.find((code) => message === code || message.startsWith(`${code}:`)) ??
      'hidden',
    failureKind: obsFailureKind(error),
    detailStatus: 'classification_only',
    message: '此摘要仅含安全分类，不包含原始错误详情。',
  };
}

/** Keep explicit operator audio choices visible without treating them as configuration failures. */
export function obsFindingReadiness(findings: readonly ObsFinding[]) {
  const warnings: ObsFinding[] = [];
  const blockingFindings: ObsFinding[] = [];
  for (const finding of findings) {
    const code = finding.code.split(':', 1)[0] ?? '';
    const audioWarning =
      code.startsWith('audio_') || code === 'game_audio_missing' || code === 'commentary_pending';
    (audioWarning ? warnings : blockingFindings).push(finding);
  }
  return { blockingFindings, warnings };
}

const commentaryPreparationMessages: Record<string, string> = {
  audio_global_path_unresolved: 'OBS 仍启用了全局音频，请先关闭重复的全局采集，再重试自动配置。',
  audio_nested_path_unresolved:
    'Mizar 场景包含嵌套音频路径，请先将音频改为直接来源，再重试自动配置。',
  audio_video_path_unresolved:
    '画面来源仍附带采集声音，请将它选为对应音频分路，或关闭附带音频后重试。',
  audio_bindings_incomplete: '已选择的音频来源已失效，请在声音设置中重新选择。',
  audio_game_target_changed: '游戏声音来源的目标已变化，请在声音设置中重新选择游戏声音并录制试听。',
  audio_game_capture_missing: '未找到游戏画面来源，请先核对游戏采集，再选择游戏声音来源。',
  audio_game_missing: '游戏声音来源已不存在，请在声音设置中重新选择并录制试听。',
};
export function commentaryPreparationFinding(error: unknown, uncertain: boolean): ObsFinding {
  const reason = error instanceof Error ? error.message : '';
  return {
    code: reason.startsWith('audio_game_') ? reason : 'commentary_pending',
    message:
      commentaryPreparationMessages[reason] ??
      (uncertain
        ? '解说来源切换结果待核对，请在 OBS 中检查后处理。'
        : '场景已准备，音频分路尚未确认。请在声音设置中核对来源并录制试听。'),
  };
}
