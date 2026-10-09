import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createHudPresetPack,
  getBuiltinLayout,
  getBuiltinPreset,
  getBuiltinTheme,
  type HudConfigDocument,
} from '@mizar/hud-config';

import { buildApp } from '../src/app.js';
import { HudConfigStore } from '../src/hud-config/store.js';

const LOCAL_MUTATION_HEADERS = { origin: 'http://127.0.0.1' };

interface HudOnAirBody {
  readonly resolved: { readonly preset: { readonly id: string; readonly name: string } };
  readonly etag: string;
  readonly activeRevision: string;
}

interface HudEditorBody {
  readonly document: HudConfigDocument;
  readonly etag: string;
  readonly revision: string;
  readonly activationStale: boolean;
}

interface HudMutationBody {
  readonly command: {
    readonly kind: string;
    readonly resource?: string;
    readonly resourceId?: string;
    readonly sourceId?: string;
  };
  readonly onAir: HudOnAirBody;
  readonly editor: HudEditorBody;
}

function parseHudOnAirBody(value: unknown): HudOnAirBody {
  if (typeof value !== 'object' || value === null) throw new Error('HUD response is not an object');
  return value as HudOnAirBody;
}

function parseHudEditorBody(value: unknown): HudEditorBody {
  if (typeof value !== 'object' || value === null) throw new Error('HUD response is not an object');
  return value as HudEditorBody;
}

function parseHudMutationBody(value: unknown): HudMutationBody {
  if (typeof value !== 'object' || value === null) throw new Error('HUD response is not an object');
  return value as HudMutationBody;
}

describe('HUD config control plane', () => {
  let app: FastifyInstance | undefined;
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    if (app !== undefined) await app.close();
    app = undefined;
    await Promise.all(
      temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
    );
  });

  it('accepts versioned packs with CAS and keeps imports loopback-only and off-air', async () => {
    const store = new HudConfigStore();
    app = buildApp({ hudConfigStore: store });
    const before = store.getState();
    const payload = {
      kind: 'import-preset-pack',
      value: createHudPresetPack(getBuiltinPreset(), getBuiltinLayout(), getBuiltinTheme()),
      expectedEditorRevision: before.editorRevision,
    };
    expect(
      (await app.inject({ method: 'POST', url: '/operator/hud-config', payload })).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/operator/hud-config',
          headers: { origin: 'https://remote.example' },
          payload,
        })
      ).statusCode,
    ).toBe(403);
    const imported = await app.inject({
      method: 'POST',
      url: '/operator/hud-config',
      headers: LOCAL_MUTATION_HEADERS,
      payload,
    });
    expect(imported.statusCode).toBe(200);
    expect(parseHudMutationBody(imported.json()).command.kind).toBe('import-preset-pack');
    expect(store.getState().resolved).toEqual(before.resolved);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/operator/hud-config',
          headers: LOCAL_MUTATION_HEADERS,
          payload,
        })
      ).statusCode,
    ).toBe(409);
    const after = store.getState();
    const invalid = await app.inject({
      method: 'POST',
      url: '/operator/hud-config',
      headers: LOCAL_MUTATION_HEADERS,
      payload: {
        ...payload,
        expectedEditorRevision: after.editorRevision,
        value: { ...payload.value, formatVersion: 999 },
      },
    });
    expect(invalid.statusCode).toBe(400);
    expect(store.getState().document).toEqual(after.document);
    await app.close();
    app = buildApp({
      host: '192.168.1.20',
      localWebLanMode: true,
      localWebAllowedOrigins: ['http://caster-pc:4173'],
    });
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/operator/hud-config',
          headers: { origin: 'http://caster-pc:4173' },
          payload,
        })
      ).statusCode,
    ).toBe(403);
  });

  it('serves the resolved preset with conditional ETag polling', async () => {
    app = buildApp({
      hudConfigStore: new HudConfigStore(),
    });

    const first = await app.inject({ method: 'GET', url: '/local/v1/hud-config' });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({
      resolved: { preset: { id: 'builtin:mizar-default-preset' } },
    });

    const notModified = await app.inject({
      method: 'GET',
      url: '/local/v1/hud-config',
      headers: { 'if-none-match': first.headers.etag },
    });
    expect(notModified.statusCode).toBe(304);
    expect(notModified.headers.etag).toBe(first.headers.etag);
  });

  it('keeps on-air and editor validators independent across two clients', async () => {
    app = buildApp({ hudConfigStore: new HudConfigStore() });
    const initialOnAir = parseHudOnAirBody(
      (await app.inject({ method: 'GET', url: '/local/v1/hud-config' })).json(),
    );
    const initialEditorResponse = await app.inject({
      method: 'GET',
      url: '/operator/hud-config',
    });
    expect(initialEditorResponse.statusCode).toBe(200);
    const initialEditor = parseHudEditorBody(initialEditorResponse.json());

    const saved = await app.inject({
      method: 'POST',
      url: '/operator/hud-config',
      headers: LOCAL_MUTATION_HEADERS,
      payload: {
        kind: 'save-as',
        resource: 'theme',
        value: { ...getBuiltinTheme(), id: 'client-a-theme', name: '客户端 A 外观' },
        expectedEditorRevision: initialEditor.revision,
      },
    });
    expect(saved.statusCode).toBe(200);
    const savedBody = parseHudMutationBody(saved.json());
    expect(savedBody.command).toMatchObject({ kind: 'save-as', resource: 'theme' });
    expect(savedBody.command.resourceId).toEqual(expect.any(String));
    expect(savedBody.onAir.etag).toBe(initialOnAir.etag);
    expect(savedBody.onAir.resolved.preset.id).toBe(initialOnAir.resolved.preset.id);
    expect(savedBody.editor.etag).not.toBe(initialEditor.etag);
    expect(savedBody.editor.document.customThemes).toHaveLength(1);

    const onAirNotModified = await app.inject({
      method: 'GET',
      url: '/local/v1/hud-config',
      headers: { 'if-none-match': initialOnAir.etag },
    });
    expect(onAirNotModified.statusCode).toBe(304);

    const editorAfterSave = await app.inject({
      method: 'GET',
      url: '/operator/hud-config',
      headers: { 'if-none-match': initialEditor.etag },
    });
    expect(editorAfterSave.statusCode).toBe(200);
    expect(editorAfterSave.headers.etag).toBe(savedBody.editor.etag);
    expect(parseHudEditorBody(editorAfterSave.json()).document.customThemes).toHaveLength(1);
  });

  it('rejects a stale editor revision without overwriting the saved document', async () => {
    app = buildApp({ hudConfigStore: new HudConfigStore() });
    const initial = parseHudEditorBody(
      (await app.inject({ method: 'GET', url: '/operator/hud-config' })).json(),
    );
    const first = await app.inject({
      method: 'POST',
      url: '/operator/hud-config',
      headers: LOCAL_MUTATION_HEADERS,
      payload: {
        kind: 'save-as',
        resource: 'theme',
        value: { ...getBuiltinTheme(), id: 'theme-a', name: '页面 A' },
        expectedEditorRevision: initial.revision,
      },
    });
    expect(first.statusCode).toBe(200);
    const stale = await app.inject({
      method: 'POST',
      url: '/operator/hud-config',
      headers: LOCAL_MUTATION_HEADERS,
      payload: {
        kind: 'save-as',
        resource: 'theme',
        value: { ...getBuiltinTheme(), id: 'theme-b', name: '页面 B' },
        expectedEditorRevision: initial.revision,
      },
    });

    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toEqual({
      error: 'hud_config_editor_conflict',
      message: 'HUD 配置已在另一页面更新，请先处理冲突。',
    });
    const editor = parseHudEditorBody(
      (await app.inject({ method: 'GET', url: '/operator/hud-config' })).json(),
    );
    expect(editor.document.customThemes.map((theme) => theme.name)).toEqual(['页面 A']);
  });

  it('returns 500 for persistence failures without leaking OS details', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rivalhub-hud-controller-'));
    temporaryDirectories.push(directory);
    const store = new HudConfigStore({ filePath: directory });
    app = buildApp({ hudConfigStore: store });
    const editor = parseHudEditorBody(
      (await app.inject({ method: 'GET', url: '/operator/hud-config' })).json(),
    );
    const response = await app.inject({
      method: 'POST',
      url: '/operator/hud-config',
      headers: LOCAL_MUTATION_HEADERS,
      payload: {
        kind: 'save-as',
        resource: 'theme',
        value: { ...getBuiltinTheme(), id: 'theme-failure', name: '持久化失败' },
        expectedEditorRevision: editor.revision,
      },
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      error: 'hud_config_persistence_failed',
      message: 'HUD 配置暂时无法保存，请查看本机诊断日志。',
    });
    expect(store.getState().document.customThemes).toHaveLength(0);
  });

  it('keeps save and activate as separate mutations', async () => {
    app = buildApp();
    const initial = await app.inject({ method: 'GET', url: '/local/v1/hud-config' });
    const initialEditor = await app.inject({ method: 'GET', url: '/operator/hud-config' });
    const initialEditorBody = parseHudEditorBody(initialEditor.json());
    const initialBody = parseHudOnAirBody(initial.json());
    const initialEtag = initialBody.etag;
    const preset = { ...getBuiltinPreset(), id: 'draft-preset', name: '现场预设' };

    const saved = await app.inject({
      method: 'POST',
      url: '/operator/hud-config',
      headers: LOCAL_MUTATION_HEADERS,
      payload: {
        kind: 'save-as',
        resource: 'preset',
        value: preset,
        expectedEditorRevision: initialEditorBody.revision,
      },
    });
    expect(saved.statusCode).toBe(200);
    const savedBody = parseHudMutationBody(saved.json());
    const customPresetId = savedBody.command.resourceId;
    if (customPresetId === undefined) throw new Error('save-as did not return a preset identity');
    expect(savedBody.command).toMatchObject({ kind: 'save-as', resource: 'preset' });
    expect(savedBody.onAir.etag).toBe(initialEtag);
    expect(savedBody.editor.activationStale).toBe(false);

    const activated = await app.inject({
      method: 'POST',
      url: '/operator/hud-config',
      headers: LOCAL_MUTATION_HEADERS,
      payload: {
        kind: 'activate-preset',
        sourceId: customPresetId,
        expectedEditorRevision: savedBody.editor.revision,
      },
    });
    expect(activated.statusCode).toBe(200);
    const activatedBody = parseHudMutationBody(activated.json());
    expect(activatedBody.command).toMatchObject({
      kind: 'activate-preset',
      sourceId: customPresetId,
    });
    expect(activatedBody).toMatchObject({
      onAir: { resolved: { preset: { id: customPresetId, name: '现场预设' } } },
      editor: { activationStale: false },
    });
    expect(activatedBody.onAir.etag).not.toBe(initialEtag);

    const repeated = await app.inject({
      method: 'POST',
      url: '/operator/hud-config',
      headers: LOCAL_MUTATION_HEADERS,
      payload: {
        kind: 'activate-preset',
        sourceId: customPresetId,
        expectedEditorRevision: activatedBody.editor.revision,
      },
    });
    const repeatedBody = parseHudMutationBody(repeated.json());
    expect(repeatedBody.onAir.etag).toBe(activatedBody.onAir.etag);
  });
});
