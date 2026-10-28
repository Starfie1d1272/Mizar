import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../../apps/companion/src/app.js';
import type { MixerChannel, MixerCommand, MixerStatus } from '../../packages/protocol/src/mixer.js';
import { registerMixerRoutes } from '../../apps/companion/src/obs/mixer-routes.js';
import type { ObsAdapter } from '../../apps/companion/src/obs/adapter.js';
import { MusicStore } from '../../apps/companion/src/music/store.js';
import { MusicDirector } from '../../apps/companion/src/music/director.js';
import { musicProgram } from '../../apps/companion/test/music-fixtures.js';
import { test, expect } from './companion-isolation.js';

test('browser uses real companion mixer routes and recovers after an OBS disconnection', async ({
  page,
  context,
}) => {
  const dir = await mkdtemp(join(tmpdir(), 'mizar-mixer-browser-'));
  const app = buildApp();
  const store = new MusicStore(dir);
  await store.load();
  const director = new MusicDirector(
    store,
    { session: () => Promise.reject(new Error('fake OBS offline')), close: async () => {} },
    () => ({ program: musicProgram(), active: 'waiting', production: false }),
  );
  let offline = false;
  let disconnectOnWrite = false;
  const channels = Object.fromEntries(
    ['game', 'remoteCommentary', 'microphone'].map((name) => [
      name,
      { name, volume: 0.8, muted: false, control: 'available' },
    ]),
  ) as Record<Exclude<MixerChannel, 'music'>, MixerStatus['channels']['game']>;
  const adapter = {
    mixerRead: async () =>
      offline ? Promise.reject(new Error('offline')) : { revision: 'test-revision', channels },
    mixerWrite: (command: MixerCommand) => {
      if (disconnectOnWrite) {
        offline = true;
        disconnectOnWrite = false;
      }
      if (offline)
        return Promise.resolve({ status: 'unknown' as const, message: 'OBS 连接未确认。' });
      const channel = channels[command.channel as Exclude<MixerChannel, 'music'>];
      if (command.volume !== undefined) channel.volume = command.volume;
      if (command.muted !== undefined) channel.muted = command.muted;
      return Promise.resolve({ status: 'confirmed' as const });
    },
  } as unknown as ObsAdapter;
  registerMixerRoutes(app, adapter, director, undefined, {
    mode: 'loopback',
    bindHost: '127.0.0.1',
    allowedOrigins: [],
  });
  await app.ready();
  await context.route(/\/(?:local\/v1\/mixer|operator\/mixer)$/, async (route) => {
    const request = route.request();
    const response = await app.inject({
      method: request.method() as 'GET' | 'POST',
      url: new URL(request.url()).pathname,
      headers: { ...request.headers(), host: '127.0.0.1', origin: 'http://127.0.0.1:3000' },
      ...(request.postData() ? { payload: request.postData()! } : {}),
    });
    await route.fulfill({
      status: response.statusCode,
      body: response.body,
      contentType: 'application/json',
    });
  });
  try {
    await page.goto('/settings?tab=music');
    for (const [label, key] of [
      ['游戏', 'game'],
      ['其他解说', 'remoteCommentary'],
      ['麦克风', 'microphone'],
    ] as const) {
      const slider = page.getByRole('slider', { name: `${label}音量` });
      await expect(slider).toBeEnabled();
      await slider.focus();
      await page.keyboard.press('ArrowLeft');
      await expect.poll(() => channels[key].volume).toBeCloseTo(0.79);
      await page.getByRole('button', { name: `静音${label}` }).click();
      await expect.poll(() => channels[key].muted).toBe(true);
    }
    const musicSlider = page.getByRole('slider', { name: '音乐音量' });
    await expect(musicSlider).toBeEnabled();
    await musicSlider.focus();
    await page.keyboard.press('ArrowLeft');
    await expect.poll(() => store.state.master).toBeCloseTo(0.99);
    await page.getByRole('button', { name: '静音音乐' }).click();
    await expect.poll(() => store.state.muted).toBe(true);
    await expect(page.getByRole('button', { name: '取消静音音乐' })).toBeEnabled({
      timeout: 10000,
    });
    disconnectOnWrite = true;
    await page.getByRole('button', { name: '取消静音游戏' }).click();
    await expect(page.getByRole('alert')).toContainText('未确认');
    await expect(page.getByRole('slider', { name: '游戏音量' })).toBeDisabled({ timeout: 6000 });
    offline = false;
    await expect(page.getByRole('slider', { name: '游戏音量' })).toBeEnabled({ timeout: 6000 });
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
