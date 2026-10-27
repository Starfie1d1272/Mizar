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
    await expect(page.getByRole('heading', { name: '声音', exact: true, level: 1 })).toBeVisible();
    await expect(page.getByText('尚未选曲 · 静音', { exact: true })).toHaveCount(7);
    await page
      .getByLabel('选择本地曲目', { exact: true })
      .first()
      .setInputFiles({ name: '合成等待.mp3', mimeType: 'audio/mpeg', buffer: mp3 });
    await expect(page.getByText('曲目已选，请保存音乐配置。')).toBeVisible();
    await page
      .getByRole('navigation', { name: '音乐场景' })
      .getByRole('button', { name: /技术暂停/ })
      .click();
    await page
      .getByRole('navigation', { name: '音乐场景' })
      .getByRole('button', { name: /等待音乐/ })
      .click();
    await expect(page.getByText('合成等待.mp3', { exact: true }).first()).toBeVisible();
    await page.getByRole('button', { name: '保存音乐配置', exact: true }).click();
    await expect(page.getByText('音乐配置已保存。')).toBeVisible();
    expect(service.store.state.config.groups.waiting.tracks[0]?.name).toBe('合成等待.mp3');
    await expect(page.getByLabel('正式播放曲目')).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('formal-player.png') });
    await expect(page.getByRole('button', { name: '保存音乐配置', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: '移除 合成等待.mp3', exact: true }).click();
    await expect(page.getByText('有未保存修改', { exact: true })).toBeVisible();
    expect(service.store.state.config.groups.waiting.tracks).toHaveLength(1);
    await page.reload();
    await expect(page.getByRole('list', { name: '等待音乐曲目列表' })).toContainText(
      '合成等待.mp3',
    );

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
    await expect(page.getByLabel('正式播放曲目')).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('formal-player.png') });
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
    await expect(page.getByLabel('正式播放曲目')).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('formal-player.png') });
    await page.getByRole('button', { name: '停止音乐', exact: true }).click();
    await expect(page.getByText('音乐已停止')).toBeVisible();
    await service.app.close();
    service = await start();
    await page.reload();
    await expect(page.getByText('音乐已停止')).toBeVisible();
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
    await expect(page.getByText('当前无音乐', { exact: true })).toBeVisible();
    const pack = musicZip({
      'music.json': Buffer.from(JSON.stringify(musicManifest())),
      'audio/等待.wav': musicWav(1),
    });
    await page.getByText('导入音乐包', { exact: true }).click();
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

test('auditions unsaved drafts through the owned OBS protocol channel with output confirmation, independent save and cleanup', async ({
  page,
  context,
}, testInfo) => {
  // Protocol/UI evidence only: MediaObs does not decode audio and cannot prove actual listening.
  const { MediaObs } = await import('../../apps/companion/test/music-fixtures.js');
  const directory = await mkdtemp(join(tmpdir(), 'mizar-preview-ui-'));
  const journal = new SessionJournal(join(directory, 'logs'));
  const store = new MusicStore(directory, (stage, evidence) => journal.record(stage, evidence));
  await store.load();
  const obs = new MediaObs();
  obs.streamActive = true;
  const program = musicProgram();
  program.map.phase = null;
  program.map.name = null;
  program.status.telemetry = 'awaiting';
  const director = new MusicDirector(
    store,
    {
      session: (run) => run(obs, 1),
      close: () => Promise.resolve(),
    },
    () => ({ program, active: 'waiting', production: false }),
  );
  const app = buildApp({ supportLogsDirectory: join(directory, 'logs'), supportJournal: journal });
  registerMusicRoutes(app, store, director, {
    mode: 'loopback',
    bindHost: '127.0.0.1',
    allowedOrigins: [],
  });
  await app.ready();
  const timer = setInterval(() => void director.tick(), 100);
  await context.route(
    /\/(?:local\/v1\/music|operator\/music(?:\/(?:track|preview))?|debug\/(?:control-event|support-bundle))$/,
    async (route) => {
      const request = route.request();
      const payload = request.postDataBuffer();
      const response = await app.inject({
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
  const input = () => [...obs.inputs.values()][0]!;
  try {
    await page.goto('/settings?tab=music');
    await expect(
      page.getByRole('button', { name: '试听本组', exact: true }).first(),
    ).toBeDisabled();
    await page
      .getByLabel('选择本地曲目', { exact: true })
      .first()
      .setInputFiles([
        { name: '合成一.wav', mimeType: 'audio/wav', buffer: musicWav() },
        { name: '合成二.wav', mimeType: 'audio/wav', buffer: musicWav(1) },
      ]);
    await expect(page.getByText('曲目已选，请保存音乐配置。')).toBeVisible();
    const slider = page.getByRole('slider', { name: /场景音量/ }).first();
    await slider.fill('0.75');
    await page.getByRole('button', { name: '试听 合成二.wav', exact: true }).click();
    await expect(page.getByText(/OBS 正在直播、录制或状态未知/)).toBeVisible();
    expect(store.state.sources.stinger).toBeNull();
    expect(store.state.config.groups.waiting.tracks).toEqual([]);
    await page.getByRole('button', { name: '确认通过 OBS 试听', exact: true }).click();
    await expect(page.getByText('正在通过 OBS 试听，最多 15 秒。')).toBeVisible();
    await slider.fill('1');
    await expect.poll(() => input().volume).toBe(1);
    expect(store.state.config.groups.waiting.volume).toBe(0.5);
    await page.getByRole('button', { name: '保存音乐配置', exact: true }).click();
    await expect(page.getByText('音乐配置已保存。')).toBeVisible();
    expect(store.state.config.groups.waiting.volume).toBe(1);
    expect(store.state.config.groups.waiting.tracks).toHaveLength(2);
    expect(input().file).toContain(store.state.config.groups.waiting.tracks[1]!.id);
    for (const [width, height] of [
      [1280, 720],
      [1920, 1080],
      [2560, 1440],
    ]) {
      await page.setViewportSize({ width: width!, height: height! });
      await page.getByText('正在通过 OBS 试听，最多 15 秒。').scrollIntoViewIfNeeded();
      await expect(
        page.getByRole('button', { name: '停止试听', exact: true }).first(),
      ).toBeInViewport();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      const path = testInfo.outputPath(`preview-${width}.png`);
      await page.screenshot({ path, fullPage: true });
      await testInfo.attach(`preview-${width}-protocol-simulator`, {
        path,
        contentType: 'image/png',
      });
    }
    const other = await context.newPage();
    await other.goto('/settings?tab=music');
    await other.getByRole('button', { name: '试听本组', exact: true }).first().click();
    await expect(other.getByText('音效通道或其他窗口正在使用试听，请先停止。')).toBeVisible();
    expect(input().state).toBe('OBS_MEDIA_STATE_PLAYING');
    await other.close();
    await page
      .getByRole('navigation', { name: '音乐场景' })
      .getByRole('button', { name: /技术暂停/ })
      .click();
    await expect.poll(() => input().state).toBe('OBS_MEDIA_STATE_STOPPED');
    expect(store.state.held).toBe(false);
    expect(store.state.consumed).toEqual([]);
    await page
      .getByRole('navigation', { name: '音乐场景' })
      .getByRole('button', { name: /等待音乐/ })
      .click();
    obs.streamActive = false;
    await page.getByRole('button', { name: '试听本组', exact: true }).first().click();
    await expect(page.getByText('正在通过 OBS 试听，最多 15 秒。')).toBeVisible();
    await page.getByRole('button', { name: '音源', exact: true }).click();
    await expect.poll(() => input().state, { timeout: 6000 }).toBe('OBS_MEDIA_STATE_STOPPED');
    await page.waitForTimeout(1500);
    expect(input().state).toBe('OBS_MEDIA_STATE_STOPPED');
    expect(store.state.held).toBe(false);
    await page
      .getByRole('navigation', { name: '声音设置分区' })
      .getByRole('button', { name: '音乐', exact: true })
      .click();
    await page.getByRole('button', { name: '试听本组', exact: true }).first().click();
    await expect(page.getByText('正在通过 OBS 试听，最多 15 秒。')).toBeVisible();
    await page.goto('/');
    await expect.poll(() => input().state, { timeout: 6000 }).toBe('OBS_MEDIA_STATE_STOPPED');
    await page.goto('/settings?tab=music');
    const choice = `waiting:${store.state.config.groups.waiting.tracks[0]!.entryId}`;
    await expect(page.getByLabel('正式播放曲目').locator(`option[value="${choice}"]`)).toHaveCount(
      1,
    );
    await page.getByLabel('正式播放曲目').selectOption(choice);
    await page.getByRole('button', { name: '播放所选' }).click();
    await expect(page.getByText(/人工播放 · OBS：播放中/)).toBeVisible();
    const bgm = () => obs.bgm();
    await page.getByRole('slider', { name: '播放进度' }).fill('2000');
    await page.getByRole('slider', { name: '播放进度' }).press('Tab');
    await expect.poll(() => bgm().cursor).toBe(2000);
    await page.getByRole('button', { name: '下一首', exact: true }).click();
    await expect.poll(() => bgm().file).toContain(store.state.config.groups.waiting.tracks[1]!.id);
    await page.getByRole('button', { name: '开启本机监听' }).click();
    await expect(page.getByText(/监听：已开启/)).toBeVisible();
    const pauseButton = page.getByRole('button', { name: '暂停', exact: true });
    await pauseButton.focus();
    await expect(pauseButton).toBeFocused();
    await pauseButton.press('Enter');
    await expect(page.getByRole('button', { name: '继续播放', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '继续播放', exact: true }).press('Enter');
    await expect(page.getByRole('button', { name: '暂停', exact: true })).toBeVisible();
    const longTitle = '合成音乐'.repeat(30);
    await store.update((state) => {
      if (state.bgm) state.bgm.track.name = longTitle;
    });
    await expect(page.locator('.music-player__heading').getByTitle(longTitle)).toBeVisible();
    expect(
      await page
        .locator('.music-player__heading strong')
        .evaluate((el) => el.scrollWidth > el.clientWidth),
    ).toBe(true);
    await store.update((state) => {
      if (state.bgm) state.bgm.track.name = '合成二.wav';
    });
    await expect(page.locator('.music-player__heading').getByTitle('合成二.wav')).toBeVisible();
    for (const [label, width, height] of [
      ['desktop', 1440, 900],
      ['narrow', 800, 720],
    ] as const) {
      await page.setViewportSize({ width, height });
      const player = page.locator('.music-player');
      await player.scrollIntoViewIfNeeded();
      await expect(player.getByTitle('合成二.wav')).toBeVisible();
      expect(
        await player
          .getByRole('slider', { name: '播放进度' })
          .evaluate((el) => el.getBoundingClientRect().width),
      ).toBeGreaterThan(200);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.screenshot({ path: testInfo.outputPath(`formal-player-${label}.png`) });
    }
    const exported = await app.inject({
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
      .filter((f) => f.name.startsWith('session.ndjson') && f.status === 'read')
      .flatMap((f) =>
        Buffer.concat(f.volumes.map((v) => gunzipSync(Buffer.from(v.gzipBase64, 'base64'))))
          .toString('utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line) as { stage: string; evidence: Record<string, unknown> }),
      );
    const previews = events.filter((e) => e.stage.startsWith('music_preview_'));
    expect(previews.map((e) => e.stage)).toEqual(
      expect.arrayContaining([
        'music_preview_requested',
        'music_preview_started',
        'music_preview_stopped',
      ]),
    );
    expect(previews.find((e) => e.stage === 'music_preview_requested')?.evidence).toMatchObject({
      group: 'waiting',
      volume: 0.75,
      trackId: store.state.config.groups.waiting.tracks[1]!.id,
    });
    expect(JSON.stringify(previews)).not.toContain(directory);
  } finally {
    clearInterval(timer);
    await director.close();
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
