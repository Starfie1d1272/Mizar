import {
  OBS_CAPTURE_INPUT,
  OBS_COLLECTION,
  OBS_HEIGHT,
  OBS_WIDTH,
  obsDesiredScenes,
} from './desired-state.js';

export interface ObsRpc {
  call(type: string, data?: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export interface ObsFinding {
  readonly code: string;
  readonly scene?: string;
  readonly message: string;
}

function objects(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is Record<string, unknown> => typeof item === 'object' && item !== null,
      )
    : [];
}

function names(value: unknown, key: string): string[] {
  return objects(value)
    .map((item) => item[key])
    .filter((name): name is string => typeof name === 'string');
}

function ownedScene(name: string): boolean {
  return name.startsWith('RivalHub · ');
}

async function outputActive(obs: ObsRpc): Promise<boolean> {
  const [stream, record] = await Promise.all([
    obs.call('GetStreamStatus'),
    obs.call('GetRecordStatus'),
  ]);
  return stream.outputActive === true || record.outputActive === true;
}

export async function checkObsConfiguration(obs: ObsRpc, baseUrl: string): Promise<ObsFinding[]> {
  const desired = obsDesiredScenes(baseUrl);
  const findings: ObsFinding[] = [];
  const collections = await obs.call('GetSceneCollectionList');
  if (!names(collections.sceneCollections, 'sceneCollectionName').includes(OBS_COLLECTION)) {
    findings.push({ code: 'collection_missing', message: 'RivalHub Broadcast 场景集合尚未创建。' });
    return findings;
  }
  if (collections.currentSceneCollectionName !== OBS_COLLECTION) {
    findings.push({
      code: 'collection_inactive',
      message: '当前未使用 RivalHub Broadcast 场景集合。',
    });
    return findings;
  }
  const video = await obs.call('GetVideoSettings');
  const fps = Number(video.fpsNumerator) / Number(video.fpsDenominator);
  if (
    video.baseWidth !== OBS_WIDTH ||
    video.baseHeight !== OBS_HEIGHT ||
    video.outputWidth !== OBS_WIDTH ||
    video.outputHeight !== OBS_HEIGHT ||
    Math.abs(fps - 60) > 0.01
  )
    findings.push({
      code: 'video_settings',
      message: 'OBS 画布、输出分辨率或帧率与 1920×1080 / 60fps 不一致；请手动检查视频设置。',
    });
  const scenes = await obs.call('GetSceneList');
  const sceneNames = names(scenes.scenes, 'sceneName');
  const inputs = await obs.call('GetInputList');
  const inputKinds = new Map(
    objects(inputs.inputs).map((item) => [String(item.inputName), String(item.inputKind)]),
  );
  if (inputKinds.has(OBS_CAPTURE_INPUT) && inputKinds.get(OBS_CAPTURE_INPUT) !== 'game_capture')
    findings.push({ code: 'source_kind_conflict', message: 'RivalHub 游戏采集来源名称冲突。' });
  if (inputKinds.get(OBS_CAPTURE_INPUT) === 'game_capture') {
    const capture = await obs.call('GetInputSettings', { inputName: OBS_CAPTURE_INPUT });
    const settings = capture.inputSettings as Record<string, unknown> | undefined;
    if (settings?.capture_mode !== 'window' || settings.window !== '::cs2.exe')
      findings.push({ code: 'capture_drift', message: 'RivalHub 游戏采集来源未指向 CS2。' });
  }
  for (const scene of desired) {
    if (!sceneNames.includes(scene.sceneName)) {
      findings.push({
        code: 'scene_missing',
        scene: scene.sceneName,
        message: `${scene.sceneName} 场景缺失。`,
      });
      continue;
    }
    const items = objects(
      (await obs.call('GetSceneItemList', { sceneName: scene.sceneName })).sceneItems,
    );
    const itemNames = names(items, 'sourceName');
    for (const source of scene.sources) {
      if (!itemNames.includes(source))
        findings.push({
          code: 'source_missing',
          scene: scene.sceneName,
          message: `${scene.sceneName} 缺少制播来源。`,
        });
    }
    if (scene.composition === 'gameplay_overlay') {
      const capture = items.find((item) => item.sourceName === OBS_CAPTURE_INPUT);
      const browser = items.find((item) => item.sourceName === scene.browserInput);
      if (capture && browser && Number(browser.sceneItemIndex) < Number(capture.sceneItemIndex))
        findings.push({
          code: 'order_drift',
          scene: scene.sceneName,
          message: `${scene.sceneName} 图层顺序需要修复。`,
        });
    }
    const browserItem = items.find((item) => item.sourceName === scene.browserInput);
    if (browserItem && typeof browserItem.sceneItemId === 'number') {
      const measured = await obs.call('GetSceneItemTransform', {
        sceneName: scene.sceneName,
        sceneItemId: browserItem.sceneItemId,
      });
      const transform = measured.sceneItemTransform as Record<string, unknown> | undefined;
      if (
        transform?.positionX !== 0 ||
        transform.positionY !== 0 ||
        transform.scaleX !== 1 ||
        transform.scaleY !== 1
      )
        findings.push({
          code: 'transform_drift',
          scene: scene.sceneName,
          message: `${scene.sceneName} 浏览器源位置或缩放需要修复。`,
        });
    }
    if (!inputKinds.has(scene.browserInput)) continue;
    if (inputKinds.get(scene.browserInput) !== 'browser_source') {
      findings.push({
        code: 'source_kind_conflict',
        scene: scene.sceneName,
        message: `${scene.sceneName} 来源名称与用户来源冲突。`,
      });
      continue;
    }
    const actual = await obs.call('GetInputSettings', { inputName: scene.browserInput });
    const settings = actual.inputSettings as Record<string, unknown> | undefined;
    if (
      settings?.url !== scene.browserUrl ||
      settings.width !== OBS_WIDTH ||
      settings.height !== OBS_HEIGHT
    )
      findings.push({
        code: 'url_drift',
        scene: scene.sceneName,
        message: `${scene.sceneName} 浏览器源地址或画布尺寸需要修复。`,
      });
  }
  return findings;
}

export async function repairObsConfiguration(obs: ObsRpc, baseUrl: string): Promise<ObsFinding[]> {
  const desired = obsDesiredScenes(baseUrl);
  if (await outputActive(obs)) throw new Error('OBS 正在输出；结束输出后可修复制播配置。');
  const collections = await obs.call('GetSceneCollectionList');
  const exists = names(collections.sceneCollections, 'sceneCollectionName').includes(
    OBS_COLLECTION,
  );
  if (!exists) await obs.call('CreateSceneCollection', { sceneCollectionName: OBS_COLLECTION });
  else if (collections.currentSceneCollectionName !== OBS_COLLECTION)
    await obs.call('SetCurrentSceneCollection', { sceneCollectionName: OBS_COLLECTION });
  const scenes = await obs.call('GetSceneList');
  const sceneNames = new Set(names(scenes.scenes, 'sceneName'));
  const inputs = await obs.call('GetInputList');
  const inputKinds = new Map(
    objects(inputs.inputs).map((item) => [String(item.inputName), String(item.inputKind)]),
  );
  if (inputKinds.has(OBS_CAPTURE_INPUT) && inputKinds.get(OBS_CAPTURE_INPUT) !== 'game_capture')
    throw new Error('RivalHub 游戏采集来源名称冲突，未执行修复。');
  for (const scene of desired) {
    if (
      inputKinds.has(scene.browserInput) &&
      inputKinds.get(scene.browserInput) !== 'browser_source'
    )
      throw new Error('RivalHub 浏览器来源名称冲突，未执行修复。');
  }
  if (inputKinds.get(OBS_CAPTURE_INPUT) === 'game_capture')
    await obs.call('SetInputSettings', {
      inputName: OBS_CAPTURE_INPUT,
      inputSettings: {
        capture_mode: 'window',
        window: '::cs2.exe',
        priority: 2,
        capture_cursor: false,
      },
      overlay: true,
    });
  for (const scene of desired) {
    if (!sceneNames.has(scene.sceneName)) {
      await obs.call('CreateScene', { sceneName: scene.sceneName });
      sceneNames.add(scene.sceneName);
    }
    if (scene.composition === 'gameplay_overlay' && !inputKinds.has(OBS_CAPTURE_INPUT)) {
      await obs.call('CreateInput', {
        sceneName: scene.sceneName,
        inputName: OBS_CAPTURE_INPUT,
        inputKind: 'game_capture',
        inputSettings: {
          capture_mode: 'window',
          window: '::cs2.exe',
          priority: 2,
          capture_cursor: false,
        },
        sceneItemEnabled: true,
      });
      inputKinds.set(OBS_CAPTURE_INPUT, 'game_capture');
    }
    if (!inputKinds.has(scene.browserInput)) {
      await obs.call('CreateInput', {
        sceneName: scene.sceneName,
        inputName: scene.browserInput,
        inputKind: 'browser_source',
        inputSettings: { url: scene.browserUrl, width: OBS_WIDTH, height: OBS_HEIGHT },
        sceneItemEnabled: true,
      });
      inputKinds.set(scene.browserInput, 'browser_source');
    } else if (inputKinds.get(scene.browserInput) !== 'browser_source') {
      throw new Error('RivalHub 来源名称与其它类型的 OBS 来源冲突，未执行修复。');
    } else {
      await obs.call('SetInputSettings', {
        inputName: scene.browserInput,
        inputSettings: { url: scene.browserUrl, width: OBS_WIDTH, height: OBS_HEIGHT },
        overlay: true,
      });
    }
    if (
      scene.composition === 'gameplay_overlay' &&
      inputKinds.get(OBS_CAPTURE_INPUT) !== 'game_capture'
    )
      throw new Error('RivalHub 游戏采集来源名称冲突，未执行修复。');
    let items = objects(
      (await obs.call('GetSceneItemList', { sceneName: scene.sceneName })).sceneItems,
    );
    for (const source of scene.sources) {
      if (!items.some((item) => item.sourceName === source)) {
        await obs.call('CreateSceneItem', {
          sceneName: scene.sceneName,
          sourceName: source,
          sceneItemEnabled: true,
        });
      }
    }
    items = objects(
      (await obs.call('GetSceneItemList', { sceneName: scene.sceneName })).sceneItems,
    );
    const browser = items.find((item) => item.sourceName === scene.browserInput);
    if (browser) {
      await obs.call('SetSceneItemTransform', {
        sceneName: scene.sceneName,
        sceneItemId: browser.sceneItemId,
        sceneItemTransform: { positionX: 0, positionY: 0, scaleX: 1, scaleY: 1 },
      });
      if (scene.composition === 'gameplay_overlay')
        await obs.call('SetSceneItemIndex', {
          sceneName: scene.sceneName,
          sceneItemId: browser.sceneItemId,
          sceneItemIndex: items.length - 1,
        });
    }
  }
  return checkObsConfiguration(obs, baseUrl);
}

export async function switchObsScene(
  obs: ObsRpc,
  sceneId: Parameters<typeof import('./desired-state.js').obsSceneName>[0],
) {
  const name = desiredSceneName(sceneId);
  const collections = await obs.call('GetSceneCollectionList');
  if (collections.currentSceneCollectionName !== OBS_COLLECTION)
    throw new Error('请先检查并修复 RivalHub Broadcast 场景集合。');
  const scenes = names((await obs.call('GetSceneList')).scenes, 'sceneName');
  if (!scenes.includes(name)) throw new Error('目标 OBS 场景尚未就绪，请先检查配置。');
  await obs.call('SetCurrentProgramScene', { sceneName: name });
}

function desiredSceneName(id: Parameters<typeof import('./desired-state.js').obsSceneName>[0]) {
  const scene = obsDesiredScenes('http://127.0.0.1:3000').find((item) => item.id === id);
  if (!scene || !ownedScene(scene.sceneName)) throw new Error('未知 OBS 场景。');
  return scene.sceneName;
}
