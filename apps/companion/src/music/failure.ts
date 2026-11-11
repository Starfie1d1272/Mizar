import type { MusicFailureCode } from '@mizar/protocol/music';

export function musicFailure(error: unknown): { code: MusicFailureCode; message: string } {
  const message = error instanceof Error ? error.message : '';
  if (message === 'music_obs_unavailable')
    return { code: 'obs_disconnected', message: 'OBS 尚未连接。请打开 OBS 并检查控制连接。' };
  if (message === 'music_collection_inactive' || message === 'music_scenes_missing')
    return {
      code: 'scene_missing',
      message: 'OBS 音乐场景尚未就绪。请停止输出后检查并修复 Mizar 场景。',
    };
  if (message === 'music_source_missing')
    return { code: 'source_missing', message: 'OBS 音乐来源缺失。请停止输出后重新准备音乐来源。' };
  if (message === 'music_source_conflict')
    return {
      code: 'source_conflict',
      message: '音乐来源身份冲突。请保留现有来源，在 OBS 核对场景配置。',
    };
  if (/track|file|load/.test(message))
    return { code: 'load_failed', message: '音乐文件无法加载。请重新选择或添加音乐。' };
  return {
    code: 'playback_failed',
    message: '音乐操作未确认。请在 OBS 检查音乐来源，核对后重试。',
  };
}
