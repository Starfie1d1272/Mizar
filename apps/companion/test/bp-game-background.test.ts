import { deflateSync } from 'node:zlib';
import { expect, it } from 'vitest';
import { gameBackgroundReady, hasVisiblePng } from '../src/obs/game-background.js';
import { OBS_CAPTURE_INPUT, OBS_COLLECTION, obsSceneName } from '../src/obs/desired-state.js';
import type { ObsRpc } from '../src/obs/reconcile.js';

function png(value: number, alpha = 255) {
  const chunk = (name: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    return Buffer.concat([length, Buffer.from(name), data, Buffer.alloc(4)]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(2, 0);
  header.writeUInt32BE(2, 4);
  header[8] = 8;
  header[9] = 6;
  const row = Buffer.from([0, value, value, value, alpha, value, value, value, alpha]);
  return `data:image/png;base64,${Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.concat([row, row]))), chunk('IEND', Buffer.alloc(0))]).toString('base64')}`;
}
it('rejects black, transparent, corrupt and unsupported capture frames', () => {
  expect(hasVisiblePng(png(0))).toBe(false);
  expect(hasVisiblePng(png(255, 0))).toBe(false);
  expect(hasVisiblePng('data:image/png;base64,AAAA')).toBe(false);
  expect(hasVisiblePng(png(100))).toBe(true);
});
it('requires the owned CS2 capture, available target and a visible frame', async () => {
  let image = png(80);
  let available = true;
  let enabled = true;
  const transform = {
    positionX: 0,
    positionY: 0,
    rotation: 0,
    alignment: 5,
    boundsType: 'OBS_BOUNDS_STRETCH',
    boundsWidth: 1920,
    boundsHeight: 1080,
    cropLeft: 0,
    cropRight: 0,
    cropTop: 0,
    cropBottom: 0,
    sourceWidth: 1920,
    sourceHeight: 1080,
    scaleX: 1,
    scaleY: 1,
  };
  const obs: ObsRpc = {
    async call(type) {
      await Promise.resolve();
      switch (type) {
        case 'GetSceneCollectionList':
          return { currentSceneCollectionName: OBS_COLLECTION };
        case 'GetSceneList':
          return { scenes: [{ sceneName: obsSceneName('gameplay') }] };
        case 'GetSceneItemList':
          return {
            sceneItems: [
              { sourceName: OBS_CAPTURE_INPUT, sceneItemEnabled: enabled, sceneItemId: 1 },
            ],
          };
        case 'GetVideoSettings':
          return { baseWidth: 1920, baseHeight: 1080 };
        case 'GetSceneItemTransform':
          return { sceneItemTransform: transform };
        case 'GetInputList':
          return {
            inputs: [
              { inputName: OBS_CAPTURE_INPUT, inputKind: 'game_capture', inputUuid: 'fixture' },
            ],
          };
        case 'GetInputSettings':
          return {
            inputSettings: { capture_mode: 'window', window: 'Counter-Strike 2:SDL_app:cs2.exe' },
          };
        case 'GetInputPropertiesListPropertyItems':
          return {
            propertyItems: available ? [{ itemValue: 'Counter-Strike 2:SDL_app:cs2.exe' }] : [],
          };
        case 'GetSourceScreenshot':
          return { imageData: image };
        default:
          throw new Error(type);
      }
    },
  };
  expect(await gameBackgroundReady(obs)).toBe(true);
  transform.positionX = 4000;
  expect(await gameBackgroundReady(obs)).toBe(false);
  transform.positionX = 0;
  transform.cropLeft = 1;
  expect(await gameBackgroundReady(obs)).toBe(false);
  transform.cropLeft = 0;
  enabled = false;
  expect(await gameBackgroundReady(obs)).toBe(false);
  enabled = true;
  image = png(0);
  expect(await gameBackgroundReady(obs)).toBe(false);
  image = png(80);
  available = false;
  expect(await gameBackgroundReady(obs)).toBe(false);
});
