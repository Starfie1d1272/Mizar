const messages = {
  output_active_audio: 'OBS 正在输出；停止推流和录制后配置音频。',
  collection_inactive: '请先修复并切换到 Mizar 场景集合。',
  video_audio_active: '游戏或窗口捕获已开启音频，请在 OBS 中配置麦克风，以免重复采集声音。',
  custom_audio: '已有自定义音频来源，请在 OBS 中配置，以免重复采集。',
  audio_name_conflict: 'Mizar 音频来源名称冲突，请在 OBS 中核对。',
  audio_routing_enabled: '已启用音频分路，请在 OBS 中维护音频来源。',
  output_active_repair: 'OBS 正在输出；结束输出后可修复制播配置。',
  output_active_switch: 'OBS 正在输出，暂不切换节目。',
  executable_missing: '未找到 OBS，请在设置中选择 obs64.exe。',
  executable_failed: 'OBS 程序未能打开。',
} as const;

export class ObsActionError extends Error {
  constructor(
    readonly code: keyof typeof messages,
    options?: ErrorOptions,
  ) {
    super(messages[code], options);
  }
}

export function obsActionMessage(code: keyof typeof messages) {
  return Object.hasOwn(messages, code) ? messages[code] : undefined;
}
