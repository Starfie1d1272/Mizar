import { PROGRAM_SCENES, type ProgramSceneId } from '@rivalhub-broadcast/protocol/program-scenes';

export const OBS_COLLECTION = 'RivalHub Broadcast';
export const OBS_CAPTURE_INPUT = 'RivalHub · CS2 Game Capture';
export const OBS_WIDTH = 1920;
export const OBS_HEIGHT = 1080;

export function obsSceneName(sceneId: ProgramSceneId): string {
  const scene = PROGRAM_SCENES.find((item) => item.id === sceneId)!;
  return `RivalHub · ${scene.title}`;
}

export function obsBrowserInputName(sceneId: ProgramSceneId): string {
  return `RivalHub · ${sceneId} · Program`;
}

export function obsDesiredScenes(baseUrl: string) {
  const base = new URL(baseUrl);
  if (base.hostname !== '127.0.0.1' || base.protocol !== 'http:')
    throw new Error('OBS Browser Source 必须使用本机回环地址。');
  return PROGRAM_SCENES.map((scene) => ({
    id: scene.id,
    sceneName: obsSceneName(scene.id),
    browserInput: obsBrowserInputName(scene.id),
    browserUrl: new URL(scene.path, base).toString(),
    composition: scene.mode,
    sources:
      scene.mode === 'gameplay_overlay'
        ? [OBS_CAPTURE_INPUT, obsBrowserInputName(scene.id)]
        : [obsBrowserInputName(scene.id)],
  }));
}
