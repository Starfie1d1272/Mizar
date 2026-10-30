// @vitest-environment jsdom
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { ObsAudioRouting } from '../apps/web/src/preparation/ObsAudioRouting';
import { audioModeRig } from './audio-mode-test-rig';

const webRequire = createRequire(join(process.cwd(), 'apps/web/package.json'));
const { act, createElement } = webRequire(
  'react',
) as typeof import('../apps/web/node_modules/react');
const { createRoot } = webRequire(
  'react-dom/client',
) as typeof import('../apps/web/node_modules/react-dom/client');

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.unstubAllGlobals();
});

it('switches from the actual audio controls through the real routes without duplicate capture', async () => {
  const rig = await audioModeRig();
  const requests: { method: string; url: string; status: number }[] = [];
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const method = (init?.method ?? 'GET') as 'GET' | 'POST';
    const payload = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    const result = await rig.request(method, url, payload);
    requests.push({ method, url, status: result.statusCode });
    return new Response(result.body, {
      status: result.statusCode,
      headers: { 'content-type': 'application/json' },
    });
  });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  cleanups.push(async () => {
    await act(async () => root.unmount());
    host.remove();
    await rig.close();
  });
  await act(async () => {
    root.render(createElement(ObsAudioRouting));
  });
  const button = (label: string) =>
    [...host.querySelectorAll('button')].find((item) => item.textContent === label);
  await vi.waitFor(async () => {
    await act(async () => {});
    expect(host.textContent).toContain('当前模式：未确认');
  });
  await act(async () => {
    button('切换桌面混音')!.click();
  });
  await vi.waitFor(async () => {
    await act(async () => {});
    expect(host.textContent).toContain('当前模式：桌面混音');
    expect(host.textContent).toContain('已切换桌面混音');
  });
  await act(async () => {
    button('切回独立分路')!.click();
  });
  await vi.waitFor(async () => {
    await act(async () => {});
    expect(host.textContent).toContain('当前模式：独立分路');
    expect(host.textContent).toContain('已切换独立分路');
  });
  expect(
    requests
      .filter((request) => request.url === '/operator/obs/audio-mode')
      .map((request) => request.status),
  ).toEqual([200, 200]);
  expect(rig.violations).toEqual([]);
  for (const items of rig.scenes.values()) {
    expect(items.find((item) => item.sourceUuid === 'desktop')?.sceneItemEnabled).toBe(false);
    expect(items.find((item) => item.sourceUuid === 'game')?.sceneItemEnabled).toBe(true);
    expect(items.find((item) => item.sourceUuid === 'ts')?.sceneItemEnabled).toBe(true);
  }
  expect(rig.monitor()).toBe('OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT');
  await act(async () => {
    button('切换桌面混音')!.click();
  });
  await vi.waitFor(async () => {
    await act(async () => {});
    expect(host.textContent).toContain('当前模式：桌面混音');
  });
  rig.failIndependent();
  await act(async () => {
    button('切回独立分路')!.click();
  });
  await vi.waitFor(async () => {
    await act(async () => {});
    expect(
      requests.filter((request) => request.url === '/operator/obs/audio-mode').at(-1)?.status,
    ).toBe(409);
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
  });
  expect(rig.violations).toEqual([]);
  await rig.adapter.recoverAudioMode(rig.music as never);
  expect(rig.violations).toEqual([]);
  for (const items of rig.scenes.values()) {
    expect(items.find((item) => item.sourceUuid === 'desktop')?.sceneItemEnabled).toBe(true);
    expect(items.find((item) => item.sourceUuid === 'game')?.sceneItemEnabled).toBe(false);
    expect(items.find((item) => item.sourceUuid === 'ts')?.sceneItemEnabled).toBe(false);
  }
});
