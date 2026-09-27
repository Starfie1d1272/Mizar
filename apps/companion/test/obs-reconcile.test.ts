import { expect, it } from 'vitest';
import { PROGRAM_SCENES } from '@rivalhub-broadcast/protocol/program-scenes';
import { OBS_COLLECTION, obsDesiredScenes } from '../src/obs/desired-state.js';
import {
  checkObsConfiguration,
  repairObsConfiguration,
  switchObsScene,
  type ObsRpc,
} from '../src/obs/reconcile.js';

class FakeObs implements ObsRpc {
  collection = 'User Collection';
  collections = new Set(['User Collection']);
  scenes = new Map<string, { sourceName: string; sceneItemId: number; sceneItemIndex: number }[]>();
  inputs = new Map<string, { kind: string; settings: Record<string, unknown> }>();
  outputActive = false;
  calls: string[] = [];
  nextId = 1;
  call(type: string, data: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    return Promise.resolve(this.callSync(type, data));
  }
  private callSync(type: string, data: Record<string, unknown>): Record<string, unknown> {
    this.calls.push(type);
    const name = typeof data.sceneName === 'string' ? data.sceneName : '';
    if (type === 'GetSceneCollectionList')
      return {
        currentSceneCollectionName: this.collection,
        sceneCollections: [...this.collections].map((sceneCollectionName) => ({
          sceneCollectionName,
        })),
      };
    if (type === 'CreateSceneCollection' || type === 'SetCurrentSceneCollection') {
      this.collection = String(data.sceneCollectionName);
      this.collections.add(this.collection);
      return {};
    }
    if (type === 'GetStreamStatus' || type === 'GetRecordStatus')
      return { outputActive: this.outputActive };
    if (type === 'GetVideoSettings')
      return {
        baseWidth: 1920,
        baseHeight: 1080,
        outputWidth: 1920,
        outputHeight: 1080,
        fpsNumerator: 60,
        fpsDenominator: 1,
      };
    if (type === 'GetSceneList')
      return { scenes: [...this.scenes.keys()].map((sceneName) => ({ sceneName })) };
    if (type === 'CreateScene') {
      this.scenes.set(name, []);
      return {};
    }
    if (type === 'GetInputList')
      return {
        inputs: [...this.inputs].map(([inputName, input]) => ({
          inputName,
          inputKind: input.kind,
        })),
      };
    if (type === 'CreateInput') {
      this.inputs.set(String(data.inputName), {
        kind: String(data.inputKind),
        settings: data.inputSettings as Record<string, unknown>,
      });
      this.addItem(name, String(data.inputName));
      return {};
    }
    if (type === 'SetInputSettings') {
      this.inputs.get(String(data.inputName))!.settings = {
        ...this.inputs.get(String(data.inputName))!.settings,
        ...(data.inputSettings as Record<string, unknown>),
      };
      return {};
    }
    if (type === 'GetInputSettings')
      return { inputSettings: this.inputs.get(String(data.inputName))!.settings };
    if (type === 'GetSceneItemList')
      return { sceneItems: this.scenes.get(name)?.map((item) => ({ ...item })) ?? [] };
    if (type === 'CreateSceneItem') {
      this.addItem(name, String(data.sourceName));
      return {};
    }
    if (type === 'SetSceneItemTransform') return {};
    if (type === 'SetSceneItemIndex') {
      this.scenes.get(name)!.find((item) => item.sceneItemId === data.sceneItemId)!.sceneItemIndex =
        Number(data.sceneItemIndex);
      return {};
    }
    if (type === 'SetCurrentProgramScene') return {};
    throw new Error(`unknown request ${type}`);
  }
  addItem(sceneName: string, sourceName: string) {
    const items = this.scenes.get(sceneName)!;
    items.push({ sourceName, sceneItemId: this.nextId++, sceneItemIndex: items.length });
  }
}

const baseUrl = 'http://127.0.0.1:3000';

it('derives all OBS scenes and URLs from the shared registry', () => {
  const desired = obsDesiredScenes(baseUrl);
  expect(desired.map((scene) => scene.id)).toEqual(PROGRAM_SCENES.map((scene) => scene.id));
  expect(desired.find((scene) => scene.id === 'gameplay')?.sources).toHaveLength(2);
  expect(desired.find((scene) => scene.id === 'bp')?.browserUrl).toBe(`${baseUrl}/program/bp`);
});

it('repairs only RivalHub collection, browser sources and order, then is idempotently healthy', async () => {
  const obs = new FakeObs();
  obs.scenes.set('My Camera Scene', []);
  expect((await checkObsConfiguration(obs, baseUrl)).map((finding) => finding.code)).toEqual([
    'collection_missing',
  ]);
  expect(await repairObsConfiguration(obs, baseUrl)).toEqual([]);
  expect(obs.collection).toBe(OBS_COLLECTION);
  expect(obs.scenes.get('My Camera Scene')).toEqual([]);
  expect(obs.scenes.size).toBe(PROGRAM_SCENES.length + 1);
  expect(await repairObsConfiguration(obs, baseUrl)).toEqual([]);
  expect(obs.scenes.size).toBe(PROGRAM_SCENES.length + 1);
  const bp = obsDesiredScenes(baseUrl).find((scene) => scene.id === 'bp')!;
  obs.inputs.get(bp.browserInput)!.settings.url = 'http://127.0.0.1:3000/wrong';
  expect((await checkObsConfiguration(obs, baseUrl)).map((finding) => finding.code)).toContain(
    'url_drift',
  );
  expect(await repairObsConfiguration(obs, baseUrl)).toEqual([]);
  await switchObsScene(obs, 'gameplay');
  expect(obs.calls.at(-1)).toBe('SetCurrentProgramScene');
});

it('refuses collection mutations during output and protects user source names', async () => {
  const obs = new FakeObs();
  obs.outputActive = true;
  await expect(repairObsConfiguration(obs, baseUrl)).rejects.toThrow('OBS 正在输出');
  expect(obs.collection).toBe('User Collection');
  obs.outputActive = false;
  const ownedBrowser = obsDesiredScenes(baseUrl)[0]!.browserInput;
  obs.inputs.set(ownedBrowser, { kind: 'image_source', settings: {} });
  await expect(repairObsConfiguration(obs, baseUrl)).rejects.toThrow('来源名称冲突');
  expect(obs.scenes.size).toBe(0);
});
