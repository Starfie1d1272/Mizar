import { mock } from 'node:test';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectObsNativeEvidence } from '../../apps/companion/src/obs/native-evidence.js';
import { ObsAdapter } from '../../apps/companion/src/obs/adapter.js';
import { OBS_CAPTURE_INPUT, obsSceneName } from '../../apps/companion/src/obs/desired-state.js';
import { buildApp } from '../../apps/companion/src/app.js';
import { expect, test } from './companion-isolation.js';

test('uncertain Steam launch recovery stays visible after navigation and requires cancellation acknowledgement', async ({
  page,
}, testInfo) => {
  // Explicit IPC boundary fixture: this proves recovery UX, not Windows process handling.
  await page.addInitScript(() => {
    Object.assign(window, {
      __TAURI_INTERNALS__: {
        invoke: async <T>(command: string, args?: Record<string, unknown>) => {
          await Promise.resolve();
          const restored = sessionStorage.getItem('test-cs2-restored') === 'yes';
          if (command === 'restore_cs2_backup') {
            if (args?.confirmSteamCancelled !== true) throw new Error('未确认取消 Steam 请求');
            sessionStorage.setItem('test-cs2-restored', 'yes');
          }
          return (
            command === 'cs2_config_status'
              ? {
                  pending: !restored,
                  running: false,
                  qualityPreset: 'preserve',
                  frameRateLimit: 60,
                  busy: false,
                  phase: restored ? 'idle' : 'uncertain',
                  message: restored ? '原设置已恢复。' : 'Steam 启动结果待确认，备份仍保留。',
                }
              : {}
          ) as T;
        },
      },
    });
  });
  await page.route('**/local/v1/production', (route) =>
    route.fulfill({ json: { mode: 'preparation', revision: 'recovery-1', canEnter: false } }),
  );
  await page.goto('/');
  await expect(page.getByText('正在等待 Steam 启动 CS2', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '恢复配置备份' })).toBeDisabled();
  await page.getByRole('link', { name: '设置', exact: true }).click();
  await expect(page.getByText('正在等待 Steam 启动 CS2', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: '恢复配置备份' })).toBeDisabled();
  await expect(page.getByText('恢复配置备份只恢复设置，不会启动或关闭游戏。')).toBeVisible();
  await page
    .getByRole('region', { name: '配置与恢复', exact: true })
    .screenshot({ path: testInfo.outputPath('cs2-recovery-steam-pending.png') });
  await page.getByRole('checkbox', { name: '已取消 Steam 启动请求，并确认 CS2 已关闭' }).check();
  await page.getByRole('button', { name: '恢复配置备份' }).click();
  await expect(page.getByRole('button', { name: '恢复配置备份' })).toHaveCount(0);
  await expect(page.getByText('原设置已恢复', { exact: true })).toBeVisible();
});

test('OBS capture guidance uses real production routes without GET Origin and applies recheck results immediately', async ({
  browser,
}, testInfo) => {
  const page = await browser.newPage({
    baseURL: String(testInfo.project.use.baseURL),
    viewport: { width: 1920, height: 1080 },
  });
  const root = await mkdtemp(join(tmpdir(), 'mizar-obs-browser-'));
  const now = Date.now();
  const started = new Date(now - 120000);
  const pad = (n: number) => String(n).padStart(2, '0');
  const localTime = (date: Date) =>
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.000`;
  const filename = `${started.getFullYear()}-${pad(started.getMonth() + 1)}-${pad(started.getDate())} ${localTime(started).slice(0, 8).replaceAll(':', '-')}.txt`;
  await mkdir(join(root, 'obs-studio', 'logs'), { recursive: true });
  const log = join(root, 'obs-studio', 'logs', filename);
  const lock = `${localTime(new Date(now - 2000))}: update_hook_file: failed to update C:\\ProgramData\\obs-studio-hook\\graphics-hook64.dll (32)\n`;
  const captureLine = (text: string) =>
    `${localTime(new Date())}: [game-capture: '${OBS_CAPTURE_INPUT}'] ${text}\n`;
  let history = lock + captureLine('hook not loaded yet, retrying..');
  const saveLog = () => writeFile(log, history);
  await saveLog();
  const statusValue = {
    connection: 'connected' as const,
    currentScene: obsSceneName('waiting'),
    streaming: false,
    recording: false,
    port: 4455,
    passwordConfigured: true,
    findings: [],
    video: null,
  };
  let pauseReads = false;
  const heldReads: (() => void)[] = [];
  const resumeReads = () => {
    pauseReads = false;
    heldReads.splice(0).forEach((release) => release());
  };
  const status = mock.method(ObsAdapter.prototype, 'status', () =>
    pauseReads
      ? new Promise<typeof statusValue>((resolve) => heldReads.push(() => resolve(statusValue)))
      : Promise.resolve(statusValue),
  );
  const check = mock.method(ObsAdapter.prototype, 'check', () => Promise.resolve([]));
  const ensure = mock.method(ObsAdapter.prototype, 'ensure', () => Promise.resolve([]));
  const recovery = mock.method(ObsAdapter.prototype, 'startBrowserRecovery', () => undefined);
  const app = buildApp({
    obsConfigPath: join(root, 'obs.json'),
    readObsCaptureEvidence: () =>
      collectObsNativeEvidence({
        platform: 'win32',
        appData: root,
        readProcesses: () =>
          Promise.resolve([
            {
              role: 'obs' as const,
              pid: 42,
              startedAt: started.toISOString(),
              elevated: false,
              elevationError: null,
              portable: false,
              allowThirdParty: null,
              executablePath: null,
            },
          ]),
      }),
  });
  const getHeaders: Record<string, string>[] = [];
  try {
    app.addHook('onRequest', (request, _reply, done) => {
      if (request.method === 'GET' && request.url === '/local/v1/obs')
        getHeaders.push(
          Object.fromEntries(
            Object.entries(request.headers).filter(
              (entry): entry is [string, string] => typeof entry[1] === 'string',
            ),
          ),
        );
      done();
    });
    // The existing Vite HTTP proxy reaches the production Companion on port 3000.
    // This browser context has no request interception or synthetic OBS response JSON.
    const address = await app.listen({ host: '127.0.0.1', port: 3000 });
    await page.goto('/settings?tab=obs');
    await expect(page.getByText('OBS 游戏挂钩尚未就绪。', { exact: true })).toBeVisible();
    const diagnostics = await page.evaluate(async () =>
      Promise.all(
        Array.from({ length: 6 }, async () => {
          const response = await fetch('/local/v1/obs');
          return ((await response.json()) as { captureDiagnostic: { state: string } })
            .captureDiagnostic;
        }),
      ),
    );
    expect(diagnostics.every((value) => value?.state === 'needs_attention')).toBe(true);
    expect(getHeaders.length).toBeGreaterThanOrEqual(6);
    expect(
      getHeaders.every(
        (headers) => headers.origin === undefined && headers['sec-fetch-site'] === 'same-origin',
      ),
    ).toBe(true);
    await page.getByText('处理捕获问题', { exact: true }).click();
    await expect(page.getByText(/最近日志报告捕获文件被占用，占用程序未知/)).toBeVisible();
    await page.setViewportSize({ width: 1366, height: 768 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({
      path: testInfo.outputPath('obs-capture-production-guidance.png'),
      fullPage: true,
    });
    const recheck = page.getByRole('button', { name: '重新检测捕获', exact: true });
    await recheck.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByText('已重新检测，请核对当前提示与 OBS 实际画面。')).toBeVisible();
    // Hold background GETs so the result can only arrive through the real POST recheck.
    pauseReads = true;
    history += captureLine('shared texture capture successful');
    await saveLog();
    const completed = page.waitForResponse((response) =>
      response.url().endsWith('/operator/obs/check'),
    );
    await recheck.click();
    await completed;
    await expect(page.getByText('OBS 游戏挂钩尚未就绪。', { exact: true })).toHaveCount(0);
    expect(check.mock.callCount()).toBe(2);
    resumeReads();
    history += captureLine('hook not loaded yet, retrying..');
    await saveLog();
    await page.evaluate(async () => {
      await fetch('/operator/obs/check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
    });
    // The next real poll reflects new pending state; it must not resurrect the recovered lock.
    await expect(page.getByText('OBS 游戏挂钩尚未就绪。', { exact: true })).toBeVisible();
    await page.getByText('处理捕获问题', { exact: true }).click();
    await expect(page.getByText(/最近日志报告捕获文件被占用/)).toHaveCount(0);
    await expect(page.getByText(/临时添加「窗口采集」/)).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath('obs-capture-production-after-success.png'),
      fullPage: true,
    });
    history += captureLine('could not open process: cs2.exe (5)');
    await saveLog();
    await recheck.click();
    await expect(page.getByText(/OBS 打开游戏进程被拒绝（错误 5）/)).toBeVisible();
    await expect(page.getByText(/任务管理器 → 详细信息/)).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath('obs-capture-production-access-denied.png'),
      fullPage: true,
    });
    for (const headers of [
      {},
      { 'sec-fetch-site': 'cross-site', referer: 'https://example.test/' },
      { 'sec-fetch-site': 'same-origin', referer: 'https://example.test/' },
      { origin: 'https://example.test', 'sec-fetch-site': 'same-origin', referer: address + '/' },
    ]) {
      const response = await app.inject({ url: '/local/v1/obs', headers });
      expect(response.json<{ captureDiagnostic: unknown }>().captureDiagnostic).toBeNull();
    }
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/operator/obs/check',
          headers: { origin: 'https://example.test' },
          payload: {},
        })
      ).statusCode,
    ).toBe(403);
  } finally {
    resumeReads();
    await page.close();
    await app.close();
    status.mock.restore();
    check.mock.restore();
    ensure.mock.restore();
    recovery.mock.restore();
    await rm(root, { recursive: true, force: true });
  }
});
