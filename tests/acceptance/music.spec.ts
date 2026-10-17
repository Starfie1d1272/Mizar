import { gunzipSync } from 'node:zlib';
import { SessionJournal } from '../../apps/companion/src/support/session-journal.js';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
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
  const logsDirectory = join(directory, 'logs');
  const start = async () => {
    const journal = new SessionJournal(logsDirectory);
    const store = new MusicStore(directory, (stage, evidence) => journal.record(stage, evidence));
    await store.load();
    const app = buildApp({ supportLogsDirectory: logsDirectory, supportJournal: journal });
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
  const frame = await readFile(
    new URL('../../apps/companion/test/fixtures/diagnostic-tone.mp3', import.meta.url),
  );
  const mp3 = Buffer.concat(
    Array.from({ length: Math.ceil((6 * 1024 * 1024) / frame.length) }, () => frame),
  );
  await context.route(
    /\/(?:local\/v1\/music|operator\/music(?:\/(?:track|import))?|debug\/(?:control-event|support-bundle))$/,
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
      .setInputFiles({ name: '合成等待.mp3', mimeType: 'audio/mpeg', buffer: mp3 });
    await expect(page.getByText('曲目已选，请保存音乐配置。')).toBeVisible();
    await page.getByRole('button', { name: '保存音乐配置', exact: true }).click();
    await expect(page.getByText('音乐配置已保存。')).toBeVisible();
    expect(service.store.state.config.groups.waiting.tracks[0]?.name).toBe('合成等待.mp3');
    service.store.failure = true;
    service.store.ready = false;
    await page.reload();
    await expect(page.getByText(/音乐存储未就绪，原配置未加载/)).toBeVisible();
    await page.getByRole('button', { name: '重新检查音乐存储', exact: true }).click();
    await expect(page.getByText(/音乐存储未就绪，原配置未加载/)).toHaveCount(0);
    await expect(page.getByText('合成等待.mp3', { exact: true }).first()).toBeVisible();
    await page.evaluate(() => {
      const read = (file: File) => Blob.prototype.arrayBuffer.call(file);
      File.prototype.arrayBuffer = function () {
        return this.name === 'unreadable.mp3'
          ? Promise.reject(new DOMException('synthetic file read denied', 'NotReadableError'))
          : read(this);
      };
    });
    await page
      .getByLabel('选择本地曲目', { exact: true })
      .first()
      .setInputFiles({
        name: 'unreadable.mp3',
        mimeType: 'audio/mpeg',
        buffer: Buffer.from('ID3'),
      });
    await expect(
      page.getByText('文件未能读取，请确认文件仍在原位置且可以访问后重新选择。'),
    ).toBeVisible();
    expect(service.store.state.config.groups.waiting.tracks[0]?.name).toBe('合成等待.mp3');
    await page
      .getByLabel('选择本地曲目', { exact: true })
      .first()
      .setInputFiles({
        name: 'broken.mp3',
        mimeType: 'audio/mpeg',
        buffer: Buffer.from('invalid media'),
      });
    await expect(page.getByText('曲目未添加，请选择有效的本地音频（最大 32 MiB）。')).toBeVisible();
    expect(service.store.state.config.groups.waiting.tracks[0]?.name).toBe('合成等待.mp3');
    await page.getByRole('button', { name: '停止音乐', exact: true }).click();
    await expect(page.getByText('音乐 · 手动停止')).toBeVisible();
    await service.app.close();
    service = await start();
    await page.reload();
    await expect(page.getByText('音乐 · 手动停止')).toBeVisible();
    await expect(page.getByText('合成等待.mp3', { exact: true }).first()).toBeVisible();
    const exported = await service.app.inject({
      method: 'POST',
      url: '/debug/support-bundle',
      headers: { origin: 'http://127.0.0.1:3000' },
      payload: {},
    });
    expect(exported.statusCode).toBe(200);
    const files = exported.json<{
      fullLogs: { files: { name: string; status: string; volumes: { gzipBase64: string }[] }[] };
    }>().fullLogs.files;
    const events = files
      .filter((file) => file.name.startsWith('session.ndjson') && file.status === 'read')
      .flatMap((file) =>
        Buffer.concat(
          file.volumes.map((volume) => gunzipSync(Buffer.from(volume.gzipBase64, 'base64'))),
        )
          .toString('utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map(
            (line) =>
              JSON.parse(line) as {
                stage: string;
                evidence: {
                  operation?: string;
                  phase?: string;
                  evidence?: { bytes?: number; error?: { name?: string } };
                };
              },
          ),
      );
    expect(
      events.some(
        (event) =>
          event.stage === 'browser_control' &&
          event.evidence.operation === 'music_file' &&
          event.evidence.phase === 'read_success' &&
          (event.evidence.evidence?.bytes ?? 0) >= 6 * 1024 * 1024,
      ),
    ).toBe(true);
    expect(
      events.some(
        (event) =>
          event.stage === 'browser_control' &&
          event.evidence.phase === 'read_failed' &&
          event.evidence.evidence?.error?.name === 'NotReadableError',
      ),
    ).toBe(true);
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
