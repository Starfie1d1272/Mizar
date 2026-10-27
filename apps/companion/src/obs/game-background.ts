import { inflateSync } from 'node:zlib';
import { OBS_CAPTURE_INPUT, OBS_COLLECTION, obsSceneName } from './desired-state.js';
import type { ObsRpc } from './reconcile.js';

function objects(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is Record<string, unknown> => typeof item === 'object' && item !== null,
      )
    : [];
}

/** Inspect a small OBS PNG without treating source activity as proof of a picture. */
export function hasVisiblePng(data: unknown): boolean {
  if (
    typeof data !== 'string' ||
    !data.startsWith('data:image/png;base64,') ||
    data.length > 1_000_000
  )
    return false;
  try {
    const bytes = Buffer.from(data.slice('data:image/png;base64,'.length), 'base64');
    if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return false;
    let offset = 8,
      width = 0,
      height = 0,
      channels = 0;
    const chunks: Buffer[] = [];
    while (offset + 12 <= bytes.length) {
      const length = bytes.readUInt32BE(offset),
        type = bytes.toString('ascii', offset + 4, offset + 8);
      if (length > bytes.length - offset - 12) return false;
      const chunk = bytes.subarray(offset + 8, offset + 8 + length);
      if (type === 'IHDR') {
        if (
          length !== 13 ||
          chunk[8] !== 8 ||
          chunk[10] !== 0 ||
          chunk[11] !== 0 ||
          chunk[12] !== 0
        )
          return false;
        width = chunk.readUInt32BE(0);
        height = chunk.readUInt32BE(4);
        channels = chunk[9] === 6 ? 4 : chunk[9] === 2 ? 3 : 0;
      } else if (type === 'IDAT') chunks.push(chunk);
      else if (type === 'IEND') break;
      offset += 12 + length;
    }
    if (!channels || !width || !height || width > 64 || height > 64 || !chunks.length) return false;
    const stride = width * channels;
    const raw = inflateSync(Buffer.concat(chunks), { maxOutputLength: (stride + 1) * height });
    if (raw.length !== (stride + 1) * height) return false;
    let previous = Buffer.alloc(stride),
      visible = 0;
    for (let y = 0; y < height; y++) {
      const start = y * (stride + 1),
        filter = raw[start]!,
        row = Buffer.alloc(stride);
      if (filter > 4) return false;
      for (let x = 0; x < stride; x++) {
        const left = x >= channels ? row[x - channels]! : 0,
          up = previous[x]!,
          upperLeft = x >= channels ? previous[x - channels]! : 0;
        const p = left + up - upperLeft,
          pa = Math.abs(p - left),
          pb = Math.abs(p - up),
          pc = Math.abs(p - upperLeft);
        const predict =
          filter === 0
            ? 0
            : filter === 1
              ? left
              : filter === 2
                ? up
                : filter === 3
                  ? Math.floor((left + up) / 2)
                  : pa <= pb && pa <= pc
                    ? left
                    : pb <= pc
                      ? up
                      : upperLeft;
        row[x] = (raw[start + 1 + x]! + predict) & 255;
      }
      for (let x = 0; x < width; x++) {
        const i = x * channels;
        if (
          (channels === 3 || row[i + 3]! > 16) &&
          Math.max(row[i]!, row[i + 1]!, row[i + 2]!) > 12
        )
          visible++;
      }
      previous = row;
    }
    return visible >= Math.ceil(width * height * 0.02);
  } catch {
    return false;
  }
}

/** Read-only, conservative evidence; inability to inspect falls back to full-screen BP. */
export async function gameBackgroundReady(obs: ObsRpc): Promise<boolean> {
  try {
    if ((await obs.call('GetSceneCollectionList')).currentSceneCollectionName !== OBS_COLLECTION)
      return false;
    const sceneName = obsSceneName('gameplay');
    if (
      !objects((await obs.call('GetSceneList')).scenes).some(
        (scene) => scene.sceneName === sceneName,
      )
    )
      return false;
    const items = objects((await obs.call('GetSceneItemList', { sceneName })).sceneItems);
    if (
      !items.some((item) => item.sourceName === OBS_CAPTURE_INPUT && item.sceneItemEnabled === true)
    )
      return false;
    const input = objects((await obs.call('GetInputList')).inputs).find(
      (item) => item.inputName === OBS_CAPTURE_INPUT,
    );
    if (input?.inputKind !== 'game_capture' || typeof input.inputUuid !== 'string') return false;
    const settings = (await obs.call('GetInputSettings', { inputName: OBS_CAPTURE_INPUT }))
      .inputSettings as Record<string, unknown> | undefined;
    if (
      settings?.capture_mode !== 'window' ||
      typeof settings.window !== 'string' ||
      !settings.window.toLowerCase().endsWith(':cs2.exe')
    )
      return false;
    const windows = objects(
      (
        await obs.call('GetInputPropertiesListPropertyItems', {
          inputName: OBS_CAPTURE_INPUT,
          propertyName: 'window',
        })
      ).propertyItems,
    );
    if (!windows.some((item) => item.itemEnabled !== false && item.itemValue === settings.window))
      return false;
    const screenshot = await obs.call('GetSourceScreenshot', {
      sourceName: OBS_CAPTURE_INPUT,
      imageFormat: 'png',
      imageWidth: 64,
      imageHeight: 36,
    });
    if (!hasVisiblePng(screenshot.imageData)) return false;
    const current = objects((await obs.call('GetInputList')).inputs).find(
      (item) => item.inputName === OBS_CAPTURE_INPUT,
    );
    return (
      current?.inputUuid === input.inputUuid &&
      (await obs.call('GetSceneCollectionList')).currentSceneCollectionName === OBS_COLLECTION
    );
  } catch {
    return false;
  }
}
