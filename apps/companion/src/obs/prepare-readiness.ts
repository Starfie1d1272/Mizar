import type { ObsFinding } from './reconcile.js';

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
