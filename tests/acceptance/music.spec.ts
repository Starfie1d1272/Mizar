import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../../apps/companion/src/app.js';
import { musicProgram } from '../../apps/companion/test/music-fixtures.js';
import { test, expect } from './companion-isolation.js';
import { MusicStore } from '../../apps/companion/src/music/store.js';
import { MusicDirector } from '../../apps/companion/src/music/director.js';
import { registerMusicRoutes } from '../../apps/companion/src/music/routes.js';
import { musicManifest, musicWav, musicZip } from '../../apps/companion/test/music-fixtures.js';

test('saves real local choices, imports atomically, persists manual stop through service restart, and shows seven groups', async ({
  page,
  context,
}, testInfo) => {
  const directory = await mkdtemp(join(tmpdir(), 'mizar-music-ui-'));
  const start = async () => {
    const store = new MusicStore(directory);
    await store.load();
    const app = buildApp();
    const director = new MusicDirector(
      store,
      {
        session: () => Promise.reject(new Error('No real OBS in browser validation')),
        close: () => Promise.resolve(),
      },
      () => ({ program: musicProgram(), active: 'waiting', production: false }),
    );
    registerMusicRoutes(app, store, director, {
      mode: 'loopback',
      bindHost: '127.0.0.1',
      allowedOrigins: [],
    });
    await app.ready();
    return { app, store };
  };
  let service = await start();
  await context.route(
    /\/(?:local\/v1\/music|operator\/music(?:\/(?:track|import))?)$/,
    async (route) => {
      const request = route.request(),
        payload = request.postDataBuffer();
      const response = await service.app.inject({
        method: request.method() as 'GET' | 'POST',
        url: new URL(request.url()).pathname,
        headers: request.headers(),
        ...(payload ? { payload } : {}),
      });
      await route.fulfill({
        status: response.statusCode,
        body: response.body,
        contentType: 'application/json',
      });
    },
  );
  try {
    await page.goto('/settings?tab=music');
    await expect(
      page.getByRole('heading', { name: '节目音乐', exact: true, level: 1 }),
    ).toBeVisible();
    await expect(page.getByText('尚未选曲 · 静音', { exact: true })).toHaveCount(7);
    await page
      .getByLabel('选择本地曲目', { exact: true })
      .first()
      .setInputFiles({ name: '合成等待.wav', mimeType: 'audio/wav', buffer: musicWav() });
    await expect(page.getByText('曲目已选，请保存音乐配置。')).toBeVisible();
    await page.getByRole('button', { name: '保存音乐配置', exact: true }).click();
    await expect(page.getByText('音乐配置已保存。')).toBeVisible();
    expect(service.store.state.config.groups.waiting.tracks[0]?.name).toBe('合成等待.wav');
    await page.getByRole('button', { name: '停止音乐', exact: true }).click();
    await expect(page.getByText('音乐 · 手动停止')).toBeVisible();
    await service.app.close();
    service = await start();
    await page.reload();
    await expect(page.getByText('音乐 · 手动停止')).toBeVisible();
    await expect(page.getByText('合成等待.wav', { exact: true }).first()).toBeVisible();
    await page.getByRole('button', { name: '恢复自动音乐', exact: true }).click();
    await expect(page.getByText('音乐 · 静音', { exact: true })).toBeVisible();
    const pack = musicZip({
      'music.json': Buffer.from(JSON.stringify(musicManifest())),
      'audio/等待.wav': musicWav(1),
    });
    await page
      .getByLabel('一键导入音乐包', { exact: true })
      .setInputFiles({ name: 'synthetic-music.zip', mimeType: 'application/zip', buffer: pack });
    await expect(page.getByText('音乐包已导入并保存。')).toBeVisible();
    await expect(page.getByText('等待.wav', { exact: true }).first()).toBeVisible();
    const before = structuredClone(service.store.state.config);
    await page.getByLabel('一键导入音乐包', { exact: true }).setInputFiles({
      name: 'unsafe.zip',
      mimeType: 'application/zip',
      buffer: musicZip({
        'music.json': Buffer.from(JSON.stringify(musicManifest())),
        '../escape.wav': musicWav(),
      }),
    });
    await expect(page.getByText(/音乐包未导入，原配置已保留/)).toBeVisible();
    expect(service.store.state.config).toEqual(before);
    await page.screenshot({
      path: testInfo.outputPath('music-seven-groups-1920.png'),
      fullPage: true,
    });
    await testInfo.attach('music-seven-groups', {
      path: testInfo.outputPath('music-seven-groups-1920.png'),
      contentType: 'image/png',
    });
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.getByRole('button', { name: '保存音乐配置', exact: true }).scrollIntoViewIfNeeded();
    await expect(page.getByRole('button', { name: '保存音乐配置', exact: true })).toBeInViewport();
    await page.screenshot({
      path: testInfo.outputPath('music-seven-groups-1280.png'),
      fullPage: false,
    });
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.goto('/workspace');
    const music = page.getByLabel('现场音乐', { exact: true });
    await expect(music.getByRole('button', { name: '停止音乐' })).toBeVisible();
    const geometry = await music.evaluate((el) => ({
      width: el.getBoundingClientRect().width,
      height: el.getBoundingClientRect().height,
      overflow: el.scrollWidth > el.clientWidth,
    }));
    expect(geometry.overflow).toBe(false);
    await page.screenshot({
      path: testInfo.outputPath('music-workspace-1920.png'),
      fullPage: false,
    });
  } finally {
    await service.app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
