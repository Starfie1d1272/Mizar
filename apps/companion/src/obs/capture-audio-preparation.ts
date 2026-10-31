import { OBS_CAPTURE_INPUT, OBS_COLLECTION } from './desired-state.js';
import { guardedPreparationWrites, type ObsRpc } from './reconcile.js';
import { ObsVideoError } from './video-transaction.js';

const unknown = () =>
  new ObsVideoError('capture_audio_unknown', '无法确认 OBS 游戏来源的附带音频，请核对后重试。');
const enabled = () =>
  new ObsVideoError('capture_audio_enabled', 'OBS 游戏来源启用了附带音频，无法安全预热采集。');

function settings(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw unknown();
  return value as Record<string, unknown>;
}

/** Make the legacy built-in game-capture default explicit without changing an enabled source. */
export async function prepareCaptureAudio(obs: ObsRpc): Promise<void> {
  const read = async (type: string, data: Record<string, unknown>, field: string) => {
    try {
      return settings((await obs.call(type, data))[field]);
    } catch (error) {
      if (error instanceof ObsVideoError) throw error;
      throw unknown();
    }
  };
  const initial = await read('GetInputSettings', { inputName: OBS_CAPTURE_INPUT }, 'inputSettings');
  if (initial.capture_audio === false) return;
  if (initial.capture_audio === true) throw enabled();
  if (initial.capture_audio !== undefined) throw unknown();

  const defaults = await read(
    'GetInputDefaultSettings',
    { inputKind: 'game_capture' },
    'defaultInputSettings',
  );
  if (defaults.capture_audio === true) throw enabled();
  if (defaults.capture_audio !== undefined && defaults.capture_audio !== false) throw unknown();

  const identity = async (): Promise<string> => {
    if ((await obs.call('GetSceneCollectionList')).currentSceneCollectionName !== OBS_COLLECTION)
      throw unknown();
    const inputs = (await obs.call('GetInputList')).inputs;
    if (!Array.isArray(inputs)) throw unknown();
    const matches = inputs.filter(
      (item: Record<string, unknown>) => item?.inputName === OBS_CAPTURE_INPUT,
    );
    if (
      matches.length !== 1 ||
      matches[0]?.inputKind !== 'game_capture' ||
      typeof matches[0]?.inputUuid !== 'string'
    )
      throw unknown();
    return matches[0].inputUuid;
  };
  const uuid = await identity();
  const current = await read('GetInputSettings', { inputUuid: uuid }, 'inputSettings');
  if (current.capture_audio === false) return;
  if (current.capture_audio === true) throw enabled();
  if (current.capture_audio !== undefined || (await identity()) !== uuid) throw unknown();

  try {
    await guardedPreparationWrites(obs).call('SetInputSettings', {
      inputUuid: uuid,
      inputSettings: { capture_audio: false },
      overlay: true,
    });
  } catch (error) {
    if (error instanceof ObsVideoError) throw error;
    throw new ObsVideoError(
      'capture_audio_write_failed',
      'OBS 游戏来源的附带音频设置未确认，请检查 OBS 后重试。',
      { cause: error },
    );
  }
  const confirmed = await read('GetInputSettings', { inputUuid: uuid }, 'inputSettings');
  if (confirmed.capture_audio !== false || (await identity()) !== uuid) throw unknown();
}
