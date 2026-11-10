// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import type { PortableMusicConfigV1 } from '@mizar/broadcast-config';
import { defaultMusicConfig } from '@mizar/protocol/music';
import { ResourceModules, type Snapshot } from '../src/resource-library/ResourceModules';

const state = vi.hoisted(() => ({ upload: vi.fn(), metadata: {} }));
vi.mock('../src/music/music-files', () => ({ localFile: state.upload }));
vi.mock('../src/preparation/client', () => ({
  useLocalRead: (path: string | null) =>
    path?.includes('broadcast-modules') ? state.metadata : null,
}));
vi.mock('../src/resource-library/PresetVisualPreview', () => ({ PresetVisualPreview: () => null }));

it('repairs audio without saving or applying configuration, and supports cancellation and retry', async () => {
  const moduleId = 'a73b9f22-b693-4e20-b9b5-ec4cc4ea5f18';
  const groups = Object.fromEntries(
    Object.entries(defaultMusicConfig().groups).map(([name, group]) => [
      name,
      { ...group, tracks: [] },
    ]),
  ) as PortableMusicConfigV1['groups'];
  groups.technical.tracks.push({
    entryId: '1f93a460-1ad1-49fd-888d-7a4ad222ad79',
    name: 'Original cue',
    startMs: 0,
    endMs: null,
    asset: {
      fileId: `${'a'.repeat(64)}.wav`,
      resource: { id: `local:music:${'a'.repeat(64)}.wav`, version: '1', digest: 'a'.repeat(64) },
    },
  });
  const snapshot: Snapshot = {
    modules: [
      {
        id: moduleId,
        revision: 'saved',
        kind: 'music',
        schemaVersion: 1,
        name: 'Original music',
        origin: null,
        value: { version: 1, automaticEnabled: true, groups },
      },
    ],
    presets: [],
    active: {
      revision: 'active',
      sourcePreset: null,
      adjusted: false,
      sourceModuleIds: { music: moduleId },
      sourceModuleRevisions: { music: 'saved' },
    },
  };
  state.metadata = {
    consumers: {
      music: {
        desired: 'saved',
        applied: null,
        error: 'dependency_unavailable',
        persistence: 'confirmed',
      },
    },
    modules: [
      {
        id: moduleId,
        revision: 'saved',
        builtin: false,
        availability: { state: 'dependency_missing' },
      },
    ],
  };
  const original = structuredClone(snapshot);
  const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({}));
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('fetch', fetch);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const refresh = vi.fn();
  const button = (text: string) =>
    [...host.querySelectorAll('button')].find((node) => node.textContent === text)!;
  try {
    await act(async () =>
      root.render(
        <ResourceModules
          query=""
          category="music"
          onImported={() => undefined}
          sharedSnapshot={snapshot}
          onRefresh={refresh}
        />,
      ),
    );
    await act(async () => button('查看详情').click());
    const input = host.querySelector<HTMLInputElement>('[aria-label="选择待恢复的原音频"]')!;
    const choose = async (files: File[]) =>
      act(async () => {
        Object.defineProperty(input, 'files', { configurable: true, value: files });
        input.dispatchEvent(new Event('change', { bubbles: true }));
      });
    await choose([]);
    expect(state.upload).not.toHaveBeenCalled();
    let reject!: (error: Error) => void;
    state.upload.mockImplementationOnce(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        }),
    );
    const file = new File(['audio fixture'], 'cue.wav', { type: 'audio/wav' });
    await choose([file]);
    expect(button('恢复原音频').disabled).toBe(true);
    expect(button('使用').disabled).toBe(true);
    await act(async () => reject(new Error('音频校验失败')));
    expect(host.textContent).toContain('音频校验失败');
    expect(button('恢复原音频').disabled).toBe(false);
    state.upload.mockResolvedValueOnce({});
    await choose([file]);
    expect(state.upload).toHaveBeenLastCalledWith(
      '/operator/music/track/repair',
      file,
      'application/x-mizar-audio',
    );
    expect(host.textContent).toContain('音频已保存，原配置保留');
    expect(snapshot).toEqual(original);
    expect(fetch).not.toHaveBeenCalled();
    await act(async () => button('使用').click());
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[0]).toBe('/operator/broadcast-modules/apply');
    expect(refresh).toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
    state.upload.mockReset();
  }
});
