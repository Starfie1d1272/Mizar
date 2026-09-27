// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDefaultHudConfigDocument, getBuiltinResolvedPreset } from '@mizar/hud-config';

import {
  HUD_CONFIG_POLL_INTERVAL_MS,
  HudConfigClient,
  HudConfigEditorClient,
  HudConfigMutationError,
  mutateHudConfig,
} from '../src/realtime/hud-config-client';

describe('HudConfigClient', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('polls at the bounded interval and sends the resolved ETag conditionally', async () => {
    vi.useFakeTimers();
    const resolved = getBuiltinResolvedPreset();
    const responseBody = {
      resolved,
      etag: '"hud-etag"',
      activeRevision: 'hud-revision',
    };
    const fetchMock = vi.fn((_: string, init?: RequestInit) => {
      if (fetchMock.mock.calls.length === 1) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(responseBody),
        });
      }
      expect(init?.headers).toMatchObject({ 'If-None-Match': '"hud-etag"' });
      return Promise.resolve({ ok: true, status: 304, json: () => Promise.resolve(null) });
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new HudConfigClient();
    client.start();
    await vi.waitFor(() => expect(client.getSnapshot().status).toBe('ready'));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(HUD_CONFIG_POLL_INTERVAL_MS);
    await Promise.resolve();
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(client.getSnapshot().etag).toBe('"hud-etag"');
    expect(client.getSnapshot().activeRevision).toBe('hud-revision');
    client.stop();
  });

  it('applies the activated on-air revision on the next bounded poll', async () => {
    vi.useFakeTimers();
    const resolved = getBuiltinResolvedPreset();
    const fetchMock = vi.fn((_: string, init?: RequestInit) => {
      if (fetchMock.mock.calls.length === 1) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              resolved,
              etag: '"etag-before-activate"',
              activeRevision: 'revision-before-activate',
            }),
        });
      }
      expect(init?.headers).toMatchObject({ 'If-None-Match': '"etag-before-activate"' });
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            resolved: { ...resolved, preset: { ...resolved.preset, name: '已启用预设' } },
            etag: '"etag-after-activate"',
            activeRevision: 'revision-after-activate',
          }),
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new HudConfigClient();
    client.start();
    await vi.waitFor(() =>
      expect(client.getSnapshot().activeRevision).toBe('revision-before-activate'),
    );
    await vi.advanceTimersByTimeAsync(HUD_CONFIG_POLL_INTERVAL_MS);
    await vi.waitFor(() =>
      expect(client.getSnapshot().activeRevision).toBe('revision-after-activate'),
    );
    expect(client.getSnapshot().etag).toBe('"etag-after-activate"');
    expect(client.getSnapshot().current.preset.name).toBe('已启用预设');
    client.stop();
  });

  it('retains the exact last valid on-air model when polling fails', async () => {
    const resolved = getBuiltinResolvedPreset();
    const lastValid = {
      ...resolved,
      preset: { ...resolved.preset, name: '最近有效节目配置' },
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('连接暂时中断'))),
    );
    const client = new HudConfigClient();
    client.applyResponse({ resolved: lastValid, etag: '"etag"', activeRevision: 'revision' });
    client.start();
    await vi.waitFor(() => expect(client.getSnapshot().status).toBe('error'));
    expect(client.getSnapshot().current).toEqual(lastValid);
    client.stop();
  });

  it('polls the saved editor model with its own conditional revision', async () => {
    vi.useFakeTimers();
    const responseBody = {
      document: createDefaultHudConfigDocument(),
      etag: '"editor-etag"',
      revision: '"editor-etag"',
      activationStale: false,
    };
    const fetchMock = vi.fn((_: string, init?: RequestInit) => {
      if (fetchMock.mock.calls.length === 1) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(responseBody),
        });
      }
      expect(init?.headers).toMatchObject({ 'If-None-Match': '"editor-etag"' });
      return Promise.resolve({ ok: true, status: 304, json: () => Promise.resolve(null) });
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new HudConfigEditorClient();
    client.start();
    await vi.waitFor(() => expect(client.getSnapshot().status).toBe('ready'));
    await vi.advanceTimersByTimeAsync(HUD_CONFIG_POLL_INTERVAL_MS);
    await Promise.resolve();
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(client.getSnapshot().revision).toBe('"editor-etag"');
    client.stop();
  });

  it('starts unresolved and retains the last valid editor document after a poll error', async () => {
    vi.useFakeTimers();
    const document = createDefaultHudConfigDocument();
    const fetchMock = vi.fn((_: string, init?: RequestInit) => {
      if (fetchMock.mock.calls.length === 1) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              document,
              etag: '"editor-etag"',
              revision: 'revision-1',
              activationStale: false,
            }),
        });
      }
      expect(init?.headers).toMatchObject({ 'If-None-Match': '"editor-etag"' });
      return Promise.reject(new Error('连接暂时中断'));
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new HudConfigEditorClient();
    expect(client.getSnapshot().document).toBeNull();
    client.start();
    await vi.waitFor(() => expect(client.getSnapshot().status).toBe('ready'));
    expect(client.getSnapshot().document).toEqual(document);
    await vi.advanceTimersByTimeAsync(HUD_CONFIG_POLL_INTERVAL_MS);
    await vi.waitFor(() => expect(client.getSnapshot().status).toBe('error'));
    expect(client.getSnapshot().document).toEqual(document);
    client.stop();
  });

  it('sends the editor revision precondition and exposes bounded 409 conflicts', async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      void url;
      void init;
      return Promise.resolve({
        ok: false,
        status: 409,
        json: () =>
          Promise.resolve({
            error: 'hud_config_editor_conflict',
            message: '详细内部信息不应进入 UI',
          }),
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      mutateHudConfig({
        kind: 'activate-preset',
        sourceId: 'preset-a',
        expectedEditorRevision: 'revision-1',
      }),
    ).rejects.toEqual(
      expect.objectContaining({
        name: 'HudConfigMutationError',
        status: 409,
        message: '已在另一页面更新，请先处理冲突。',
      } satisfies Partial<HudConfigMutationError>),
    );
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      body: JSON.stringify({
        kind: 'activate-preset',
        sourceId: 'preset-a',
        expectedEditorRevision: 'revision-1',
      }),
    });
  });
});
