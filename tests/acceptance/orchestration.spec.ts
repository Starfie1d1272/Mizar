import {
  emptyOrchestrationPreset,
  type OrchestrationView,
} from '../../packages/protocol/src/orchestration.js';
import { mkdtemp, rm, readFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gunzipSync } from 'node:zlib';
import { test, expect } from './companion-isolation.js';
import { buildApp } from '../../apps/companion/src/app.js';
import { SessionJournal } from '../../apps/companion/src/support/session-journal.js';
import { prepareIsolatedPack } from '../../apps/companion/src/orchestration/prepare-pack.js';
import { verifyIsolatedPack } from '../../apps/companion/src/orchestration/isolated-pack.js';
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
  const source = join(root, 'source');
  await mkdir(join(source, 'CamMacros'), { recursive: true });
  await mkdir(join(source, 'Campaths'));
  await writeFile(
    join(source, 'CamMacros', 'candidate.yaml'),
    'name: 候选镜头\nKCP: { usable: false, ctrl: false, shift: false, alt: false, vkCode: 0, comboClick: 1 }\n',
  );
  const pack = await prepareIsolatedPack(source, root);
  let packRoot: string | undefined;
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
    packStatus: () => Promise.resolve({ active: pack.name, empty: true }),
    trackedStatus: () => Promise.resolve({ generation: 0, current: null }),
    cancelTracked: (generation: number) => {
      calls.push('CamPlay/ClearForce');
      return Promise.resolve({ generation: generation + 1, matched: true });
    },
    playTracked: () => {
      calls.push('CamMacro/Play');
      return Promise.resolve('queued' as const);
    },
    onTracked: () => () => {},
  };
  const director = new CameraDirector(
    store,
    provider,
    () => ({ program, production: true, active: 'waiting', manual: false }),
    (stage, evidence) => journal.record(stage, evidence),
    undefined,
    undefined,
    (name) => verifyIsolatedPack(packRoot, name),
    true,
  );
  let routeAvailable = true;
  let preparationRevision = '';
  registerOrchestrationRoutes(
    app,
    director,
    music,
    {
      mode: 'loopback',
      bindHost: '127.0.0.1',
      allowedOrigins: [],
    },
    {
      controlToken: undefined,
      configure: (revision, commit) => {
        if (revision !== preparationRevision) throw new Error('preparation changed');
        commit();
      },
    },
  );
  await app.ready();
  preparationRevision = (await app.inject('/local/v1/production')).json<{ revision: string }>()
    .revision;
  await context.route(
    /\/(?:local\/v1\/(?:orchestration|production)|operator\/orchestration)$/,
    async (route) => {
      if (!routeAvailable) {
        await route.fulfill({ status: 503, json: { error: 'fixture_closed' } });
        return;
      }
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
    },
  );
  try {
    await page.goto('/settings?tab=music&section=camera');
    await page.getByRole('button', { name: '添加地图', exact: true }).click();
    await page.getByLabel('地图', { exact: true }).fill(program.map.name!);
    await page.getByLabel('MulNX 活动包名称').fill(pack.name);
    await page.getByLabel('开场宏', { exact: true }).fill('候选镜头');
    await page.getByText('镜头时限', { exact: true }).click();
    await page.getByLabel('最多持续（秒）').fill('1.0035');
    await page.getByRole('button', { name: '保存预设', exact: true }).click();
    await expect(page.getByRole('alert')).toBeVisible();
    expect(store.preset.maps).toHaveLength(0);
    await page.getByLabel('最多持续（秒）').fill('1.003');
    await page.getByRole('button', { name: '保存预设', exact: true }).click();
    await expect.poll(() => store.preset.maps[0]?.opening?.maxMs).toBe(1003);
    await expect(page.getByText('已保存；自动运镜需重新启用。', { exact: true })).toBeVisible();
    expect(calls).toEqual([]);
    await expect(page.getByRole('button', { name: '连接 MulNX', exact: true })).toBeDisabled();
    await page.getByText('浏览器联调', { exact: true }).click();
    await page.getByRole('button', { name: '使用浏览器联调模式', exact: true }).click();
    await expect(page.getByRole('button', { name: '连接 MulNX', exact: true })).toBeEnabled();
    expect(director.get().control).toEqual({ mode: 'browser', state: 'ready' });
    await page.getByRole('button', { name: '连接 MulNX', exact: true }).click();
    await page.getByText('游戏内筛选', { exact: true }).click();
    await expect(
      page.getByRole('button', { name: '确认活动隔离包并试播', exact: true }),
    ).toBeDisabled();
    await expect(
      page.getByRole('button', { name: '准备隔离包并启用自动', exact: true }),
    ).toBeDisabled();
    packRoot = root;
    await expect(page.getByText(/隔离文件已验证/)).toBeVisible();
    await page.getByRole('button', { name: '确认活动隔离包并试播', exact: true }).click();
    await expect(page.getByText('试播请求已提交，请在游戏内核对。', { exact: true })).toBeVisible();
    expect(calls).toContain('CamPack/Apply');
    expect(calls.at(-1)).toBe('CamMacro/Play');
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
    await expect(page.getByRole('alert')).toBeVisible();
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
    routeAvailable = false;
    await context.unrouteAll({ behavior: 'wait' });
    director.close();
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('external-game browser entry uses real production lifecycle without native process adoption', async ({
  page,
  context,
}) => {
  const root = await mkdtemp(join(tmpdir(), 'mizar-camera-browser-'));
  const app = buildApp({
    matchManifestPath: join(root, 'match.json'),
    localTournamentPath: join(root, 'local.json'),
  });
  const actions: string[] = [];
  const created = await app.inject({
    method: 'POST',
    url: '/operator/local-match/create',
    headers: { origin: 'http://127.0.0.1:3000' },
    payload: { teamA: 'A', teamB: 'B', format: 'bo1' },
  });
  expect(created.statusCode).toBe(200);
  await context.route(
    /\/(?:local\/v1\/(?:production|observer-assist)|operator\/production)$/,
    async (route) => {
      const req = route.request();
      if (req.method() === 'POST') actions.push((req.postDataJSON() as { action: string }).action);
      const res = await app.inject({
        method: req.method() as 'GET' | 'POST',
        url: new URL(req.url()).pathname,
        headers: req.headers(),
        ...(req.postDataBuffer() ? { payload: req.postDataBuffer()! } : {}),
      });
      await route.fulfill({
        status: res.statusCode,
        body: res.body,
        contentType: 'application/json',
      });
    },
  );
  await context.route('**/local/v1/obs', (route) =>
    route.fulfill({ json: { connection: 'connected', findings: [], streaming: false } }),
  );
  try {
    await page.goto('/');
    expect(await page.evaluate(() => '__TAURI_INTERNALS__' in window)).toBe(false);
    await page.getByRole('button', { name: '打开直播工作台', exact: true }).click();
    await expect(page).toHaveURL(/\/workspace$/);
    expect((await app.inject('/local/v1/production')).json()).toMatchObject({ mode: 'live' });
    await page.getByRole('button', { name: '退出工作台', exact: true }).click();
    await expect(page).toHaveURL(/\/$/);
    expect((await app.inject('/local/v1/production')).json()).toMatchObject({
      mode: 'preparation',
    });
    expect(actions).toEqual(['enter', 'finish']);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('native camera settings never adopt an independently running game', async ({ page }) => {
  await page.addInitScript(() => {
    const calls: string[] = [];
    Object.assign(window, {
      cameraHandoffCalls: calls,
      __TAURI_INTERNALS__: {
        invoke: (command: string) => {
          calls.push(command);
          if (command === 'cs2_config_status')
            return Promise.resolve({ running: true, borrowed: false });
          if (command === 'mulnx_handoff_status')
            return Promise.resolve({
              processes: [
                { pid: 42, created: '123456789', executable: 'C:\\CS2\\cs2.exe', managed: false },
              ],
            });
          return Promise.resolve(false);
        },
      },
    });
  });
  await page.goto('/settings?tab=camera');
  await expect(page.getByRole('heading', { name: '运镜', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'MulNX 启动管理' })).toBeAttached();
  for (const name of ['检查游戏实例', '借用此游戏并进入工作台', '运镜试播'])
    await expect(page.getByRole('button', { name, exact: true })).toHaveCount(0);
  const calls = await page.evaluate(
    () => (window as unknown as { cameraHandoffCalls: string[] }).cameraHandoffCalls,
  );
  expect(calls).not.toContain('attach_external_cs2');
  expect(calls).not.toContain('mulnx_handoff_status');
});

test('explicit MulNX stop confirms production effects, shows ownership errors, and reports queueing once', async ({
  page,
}) => {
  let borrowed = false;
  let stops = 0;
  const preset = emptyOrchestrationPreset();
  const presetId = '00000000-0000-4000-8000-000000000001';
  const view: OrchestrationView = {
    activePresetId: presetId,
    presets: [{ id: presetId, preset }],
    tool: { installed: 'test', latest: null, busy: false, message: '', packs: [] },
    preset,
    automaticEnabled: false,
    ready: true,
    status: {
      control: { mode: 'native', state: 'blocked' },
      connected: false,
      connection: 0,
      context: '',
      map: null,
      pack: null,
      isolated: false,
      held: true,
      preparation: 'waiting',
      request: 'idle',
      execution: 'unconfirmed',
      current: null,
      message: '等待本次交接',
    },
  };
  await page.route('**/local/v1/orchestration', (route) => route.fulfill({ json: view }));
  await page.exposeFunction('stopMulnx', () => {
    stops++;
    if (!borrowed) throw new Error('请先明确借用本场 CS2。');
    return { result: 'queued', execution: 'unconfirmed' };
  });
  await page.addInitScript(() =>
    Object.assign(window, {
      __TAURI_INTERNALS__: {
        invoke: (command: string, args?: { action?: string }) => {
          if (command === 'mulnx_control' && args?.action === 'stop')
            return (window as typeof window & { stopMulnx: () => Promise<unknown> }).stopMulnx();
          return Promise.resolve(null);
        },
      },
    }),
  );
  await page.goto('/settings?tab=camera');
  await page.getByText('停止控制', { exact: true }).click();
  const stop = page.getByRole('button', { name: '停止 MulNX 控制', exact: true });
  const confirmation = page.getByRole('dialog', { name: '停止 MulNX 控制', exact: true });
  await stop.click();
  await expect(confirmation).toContainText('结束本场制作、恢复游戏 HUD');
  await expect(confirmation).toContainText('CS2 保持运行');
  await confirmation.getByRole('button', { name: '取消', exact: true }).click();
  expect(stops).toBe(0);
  await stop.click();
  await confirmation.getByRole('button', { name: '结束制作并停止控制', exact: true }).click();
  await expect(page.getByText('请先明确借用本场 CS2。', { exact: true })).toBeVisible();
  expect(stops).toBe(1);
  borrowed = true;
  await stop.click();
  await confirmation.getByRole('button', { name: '结束制作并停止控制', exact: true }).click();
  await expect(
    page.getByText(/^停止控制请求已入队，执行结果待确认。请返回游戏核对。/),
  ).toBeVisible();
  await expect(stop).toBeDisabled();
  expect(stops).toBe(2);
  await expect(page.getByText('DLL 已卸载', { exact: true })).toHaveCount(0);
});
