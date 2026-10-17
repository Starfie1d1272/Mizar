import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gunzipSync } from 'node:zlib';
import { test, expect } from './companion-isolation.js';
import { buildApp } from '../../apps/companion/src/app.js';
import { SessionJournal } from '../../apps/companion/src/support/session-journal.js';
import { CameraDirector } from '../../apps/companion/src/orchestration/director.js';
import { OrchestrationStore } from '../../apps/companion/src/orchestration/store.js';
import { registerOrchestrationRoutes } from '../../apps/companion/src/orchestration/routes.js';
import { MusicStore } from '../../apps/companion/src/music/store.js';
import { musicProgram } from '../../apps/companion/test/music-fixtures.js';

test('edits and imports saved map presets, audits them, and keeps manual ownership after audition', async ({
  page,
  context,
}, testInfo) => {
  const root = await mkdtemp(join(tmpdir(), 'mizar-camera-ui-'));
  const logs = join(root, 'logs'),
    journal = new SessionJournal(logs);
  const app = buildApp({ supportLogsDirectory: logs, supportJournal: journal });
  const store = new OrchestrationStore(join(root, 'orchestration'), (stage, evidence) =>
    journal.record(stage, evidence),
  );
  const music = new MusicStore(join(root, 'music'));
  await music.load();
  await store.load();
  const program = musicProgram();
  program.status = { context: 'fresh', telemetry: 'fresh', identity: 'matched' };
  program.series!.bindingState = 'bound';
  program.map.phase = 'warmup';
  program.clock = null;
  const calls: string[] = [];
  const provider = {
    connected: false,
    generation: 0,
    connect: () => {
      provider.connected = true;
      provider.generation++;
      return Promise.resolve();
    },
    close: () => {
      provider.connected = false;
      provider.generation++;
    },
    send: (type: string) => {
      calls.push(type);
      return Promise.resolve('queued' as const);
    },
  };
  const director = new CameraDirector(
    store,
    provider,
    () => ({ program, production: true, active: 'waiting', manual: false }),
    (stage, evidence) => journal.record(stage, evidence),
  );
  registerOrchestrationRoutes(app, director, music, {
    mode: 'loopback',
    bindHost: '127.0.0.1',
    allowedOrigins: [],
  });
  await app.ready();
  await context.route(/\/(?:local\/v1\/orchestration|operator\/orchestration)$/, async (route) => {
    const request = route.request();
    const response = await app.inject({
      method: request.method() as 'GET' | 'POST',
      url: new URL(request.url()).pathname,
      headers: request.headers(),
      ...(request.postDataBuffer() ? { payload: request.postDataBuffer()! } : {}),
    });
    await route.fulfill({
      status: response.statusCode,
      body: response.body,
      contentType: 'application/json',
    });
  });
  try {
    await page.goto('/settings?tab=music');
    await page.getByRole('button', { name: '添加地图', exact: true }).click();
    await page.getByLabel('地图', { exact: true }).fill(program.map.name!);
    await page.getByLabel('MulNX 活动包名称').fill('RC 自选测试包');
    await page.getByLabel('开场宏', { exact: true }).fill('候选镜头');
    await page.getByRole('button', { name: '保存预设', exact: true }).click();
    await expect(page.getByText('已保存；自动运镜需重新启用。', { exact: true })).toBeVisible();
    expect(calls).toEqual([]);
    await page.getByRole('button', { name: '连接 MulNX', exact: true }).click();
    await page.getByText('游戏内筛选', { exact: true }).click();
    await page.getByRole('button', { name: '试播已保存镜头', exact: true }).click();
    await expect(page.getByText('试播请求已提交，请在游戏内核对。', { exact: true })).toBeVisible();
    expect(calls).toEqual(['CamMacro/Play']);
    expect(director.get()).toMatchObject({
      held: true,
      execution: 'unconfirmed',
      request: 'queued',
    });
    await page.getByRole('button', { name: '接管运镜', exact: true }).click();
    await expect.poll(() => calls.at(-1)).toBe('CamPlay/ClearForce');
    await page.getByText('导入与导出', { exact: true }).click();
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: '导出预设', exact: true }).click();
    const download = await downloadPromise;
    const exported = await readFile(await download.path(), 'utf8');
    expect(JSON.parse(exported)).toEqual(store.preset);
    await page.getByLabel('导入预设到草稿').setInputFiles({
      name: 'invalid.json',
      mimeType: 'application/json',
      buffer: Buffer.from('{bad'),
    });
    await expect(
      page.getByText('预设未应用，请检查字段、文件与本机音频。', { exact: true }),
    ).toBeVisible();
    const modified = { ...store.preset, name: '游戏内筛选候选' };
    await page.getByLabel('导入预设到草稿').setInputFiles({
      name: 'candidate.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(modified)),
    });
    await expect(page.getByLabel('预设名称')).toHaveValue('游戏内筛选候选');
    expect(store.preset.name).toBe('我的编排');
    await page.getByRole('button', { name: '保存预设', exact: true }).click();
    await expect.poll(() => store.preset.name).toBe('游戏内筛选候选');
    const reloaded = new OrchestrationStore(store.directory);
    await reloaded.load();
    expect(reloaded.preset).toEqual(modified);
    await page.getByRole('heading', { name: '地图自动编排' }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath('orchestration-1920.png') });
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.getByRole('button', { name: '保存预设', exact: true }).focus();
    await expect(page.getByRole('button', { name: '保存预设', exact: true })).toBeFocused();
    await page.screenshot({ path: testInfo.outputPath('orchestration-1280.png') });
    const exportedLogs = await app.inject({
      method: 'POST',
      url: '/debug/support-bundle',
      headers: { origin: 'http://127.0.0.1:3000' },
      payload: {},
    });
    expect(exportedLogs.statusCode).toBe(200);
    const files = exportedLogs.json<{
      fullLogs: { files: { name: string; volumes: { gzipBase64: string }[] }[] };
    }>().fullLogs.files;
    const evidence = files
      .filter((f) => f.name.startsWith('session.ndjson'))
      .flatMap((f) =>
        Buffer.concat(f.volumes.map((v) => gunzipSync(Buffer.from(v.gzipBase64, 'base64'))))
          .toString('utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map(
            (line) =>
              JSON.parse(line) as {
                stage: string;
                evidence: { result?: string; preset?: { name: string } };
              },
          ),
      );
    expect(
      evidence.some(
        (e) =>
          e.stage === 'camera_configure' &&
          e.evidence.result === 'success' &&
          e.evidence.preset?.name === '游戏内筛选候选',
      ),
    ).toBe(true);
    expect(evidence.some((e) => e.stage === 'camera_invalidate')).toBe(true);
  } finally {
    director.close();
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
