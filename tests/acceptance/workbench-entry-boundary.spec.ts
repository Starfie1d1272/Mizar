import { expect, test, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { resolve } from 'node:path';

let server: ChildProcess;
let origin: string;
test.beforeAll(async () => {
  const port = await new Promise<number>((resolvePort, reject) => {
    const socket = createServer();
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', () => {
      const address = socket.address();
      if (!address || typeof address === 'string') return reject(new Error('No test port'));
      socket.close(() => resolvePort(address.port));
    });
  });
  origin = `http://127.0.0.1:${port}`;
  server = spawn(
    process.execPath,
    [
      'node_modules/vite/bin/vite.js',
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      '--strictPort',
    ],
    {
      cwd: resolve('apps/web'),
      stdio: 'ignore',
    },
  );
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error('Vite test server exited before it became ready');
    try {
      if ((await fetch(origin)).ok) return;
    } catch {
      /* server is starting */
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error('Vite test server did not become ready');
});
test.afterAll(() => {
  server?.kill();
});

// A browser harness mounts the real productionAction entry function. HTTP and Tauri
// are simulated; this does not claim to test Win32, an OBS process, or real CS2.
type Scenario = {
  capture?: 'initialized' | 'zero' | 'fail-once' | 'inactive';
  failEnsure?: boolean;
  holdEnsure?: boolean;
  holdCapture?: boolean;
  holdWarmupRelease?: boolean;
  failWarmupRelease?: boolean;
  activeOutput?: boolean;
  readinessBlocked?: boolean;
  external?: { pid: number; created: string };
  hidden?: boolean;
};

async function setup(page: Page, scenario: Scenario = {}) {
  const requests: string[] = [];
  const captureBodies: { expectedRevision: string; since: number; transactionId: string }[] = [];
  const warmups: { transactionId: string; startedAt: number }[] = [];
  let releaseEnsure!: () => void;
  const held = new Promise<void>((resolve) => {
    releaseEnsure = resolve;
  });
  let releaseCapture!: () => void;
  const heldCapture = new Promise<void>((resolve) => {
    releaseCapture = resolve;
  });
  let releaseWarmup!: () => void;
  const heldWarmup = new Promise<void>((resolve) => {
    releaseWarmup = resolve;
  });
  let mode = scenario.hidden ? 'hidden' : 'preparation';
  let captureChecks = 0;
  await page.route('**/entry-harness', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body></body></html>' }),
  );
  await page.route(
    (url) => url.origin === origin && /^\/(?:operator|local\/v1|debug)\//.test(url.pathname),
    async (route) => {
      const path = new URL(route.request().url()).pathname;
      requests.push(path);
      let status = 200;
      let body: unknown = {};
      if (path === '/local/v1/production') body = { mode, revision: 'revision-1', canEnter: true };
      else if (path === '/local/v1/demo-test') body = { active: false };
      else if (path === '/local/v1/obs')
        body = {
          connection: 'connected',
          findings: [],
          streaming: Boolean(scenario.activeOutput),
          recording: false,
          readiness: scenario.readinessBlocked
            ? {
                ready: false,
                reason: 'OBS 音频来源尚未就绪。',
                blockingFindings: ['audio'],
                warnings: [],
              }
            : { ready: true, reason: null, blockingFindings: [], warnings: [] },
        };
      else if (path === '/operator/obs/launch-target')
        body = { executablePath: 'C:\\OBS\\obs64.exe' };
      else if (path === '/operator/obs/video-preflight' && scenario.activeOutput) {
        status = 409;
        body = { message: 'OBS 直播正在进行，请先停止直播后重试。' };
      } else if (path === '/operator/obs/video-prepare') body = { transactionId: 'video-1' };
      else if (path === '/operator/obs/ensure') {
        if (scenario.holdEnsure) await held;
        if (scenario.failEnsure) {
          status = 409;
          body = { message: '场景自动配置失败。' };
        } else body = { ok: true, findings: [] };
      } else if (path === '/operator/obs/capture-warmup') {
        const warmup = { transactionId: `warmup-${warmups.length + 1}`, startedAt: Date.now() };
        warmups.push(warmup);
        body = warmup;
      } else if (path === '/operator/obs/capture-initialization') {
        if (scenario.holdCapture) await heldCapture;
        captureBodies.push(
          route.request().postDataJSON() as {
            expectedRevision: string;
            since: number;
            transactionId: string;
          },
        );
        captureChecks++;
        body =
          scenario.capture === 'fail-once' && captureChecks === 1
            ? { state: 'failed', reason: 'hook_failed' }
            : scenario.capture === 'inactive'
              ? { state: 'unknown', reason: 'source_inactive' }
              : scenario.capture === 'zero'
                ? { state: 'waiting', reason: 'zero_size' }
                : { state: 'initialized', reason: null };
      } else if (path === '/operator/obs/capture-warmup-release') {
        if (scenario.holdWarmupRelease) await heldWarmup;
        if (scenario.failWarmupRelease) {
          status = 409;
          body = { message: '临时捕获来源清理待完成。' };
        }
      } else if (path === '/operator/production') mode = 'live';
      try {
        await route.fulfill({ status, json: body });
      } catch {
        /* navigation or abort closed request */
      }
    },
  );
  await page.goto(`${origin}/entry-harness`);
  await page.evaluate(async (scenario) => {
    const w = window as unknown as {
      calls: string[];
      details: { name: string; args: Record<string, unknown> }[];
      running: boolean;
      preparationId: string | null;
      __TAURI_INTERNALS__: {
        invoke: (name: string, args?: Record<string, unknown>) => Promise<unknown>;
      };
    };
    w.calls = [];
    w.details = [];
    w.running = false;
    w.preparationId = null;
    w.__TAURI_INTERNALS__ = {
      invoke: async (name, args = {}) => {
        w.calls.push(name);
        w.details.push({ name, args });
        if (name === 'cs2_config_status')
          return {
            running: w.running,
            pending: false,
            busy: false,
            preparationId: w.preparationId,
          };
        if (name === 'preflight_cs2_replacement')
          return { target: scenario.external ? { ...scenario.external, managed: false } : null };
        if (name === 'gsi_status')
          return { detected: true, installed: false, conflict: false, readFailed: false };
        if (name === 'ensure_gsi')
          return { detected: true, installed: true, conflict: false, readFailed: false };
        if (name === 'replace_external_cs2') return false;
        if (name === 'start_managed_cs2') {
          w.running = true;
          w.preparationId = String(args.preparationId);
          return true;
        }
        return null;
      },
    };
    const load = new Function('path', 'return import(path)') as (path: string) => Promise<{
      productionAction: (
        action: 'enter',
        state: { mode: 'preparation' | 'hidden'; revision: string; canEnter: boolean },
        preserveSettings?: boolean,
        parentTask?: undefined,
        external?: { pid: number; created: string },
      ) => Promise<unknown>;
    }>;
    const client = await load('/src/preparation/client.ts');
    document.body.innerHTML = '<button>启动工作台</button><output></output>';
    document.querySelector('button')!.addEventListener('click', () => {
      void client
        .productionAction(
          'enter',
          {
            mode: scenario.hidden ? 'hidden' : 'preparation',
            revision: 'revision-1',
            canEnter: true,
          },
          false,
          undefined,
          scenario.external,
        )
        .then((result) => {
          document.querySelector('output')!.textContent = String(result);
        })
        .catch((error: Error) => {
          document.querySelector('output')!.textContent = error.message;
        });
    });
  }, scenario);
  const calls = () => page.evaluate(() => (window as unknown as { calls: string[] }).calls);
  const details = () =>
    page.evaluate(
      () =>
        (window as unknown as { details: { name: string; args: Record<string, unknown> }[] })
          .details,
    );
  return {
    requests,
    calls,
    details,
    captureBodies,
    warmups,
    releaseEnsure,
    releaseCapture,
    releaseWarmup,
  };
}

test('double click reuses one launch transaction, and menu without GSI can enter', async ({
  page,
}) => {
  const rig = await setup(page, { holdEnsure: true });
  await page.getByRole('button', { name: '启动工作台' }).dblclick();
  await expect
    .poll(() => rig.requests.filter((path) => path === '/operator/obs/ensure').length)
    .toBe(1);
  rig.releaseEnsure();
  await expect(page.locator('output')).toHaveText('confirmed');
  const calls = await rig.calls();
  const details = await rig.details();
  const gsi = details.find((item) => item.name === 'ensure_gsi');
  const replacement = details.find((item) => item.name === 'replace_external_cs2');
  expect(gsi?.args.preparationId).toBe(replacement?.args.preparationId);
  expect(details.indexOf(gsi!)).toBeLessThan(details.indexOf(replacement!));
  expect(calls.filter((name) => name === 'ensure_gsi')).toHaveLength(1);
  expect(calls.filter((name) => name === 'start_managed_cs2')).toHaveLength(1);
  expect(calls.filter((name) => name === 'present_production')).toHaveLength(1);
  expect(rig.requests.filter((path) => path === '/operator/production')).toHaveLength(1);
  expect(rig.requests.indexOf('/operator/obs/capture-initialization')).toBeLessThan(
    rig.requests.indexOf('/operator/obs/capture-warmup-release'),
  );
  expect(rig.requests.indexOf('/operator/obs/capture-warmup-release')).toBeLessThan(
    rig.requests.indexOf('/operator/production'),
  );
  expect(rig.captureBodies[0]).toMatchObject({
    transactionId: rig.warmups[0]?.transactionId,
    since: rig.warmups[0]?.startedAt,
  });
  expect(rig.requests.some((path) => /telemetry|\/gsi/.test(path))).toBe(false);
});

test('passes the selected external identity to replacement before managed start', async ({
  page,
}) => {
  const external = { pid: 2357, created: 'creation-marker' };
  const rig = await setup(page, { external });
  await page.getByRole('button', { name: '启动工作台' }).click();
  await expect(page.locator('output')).toHaveText('confirmed');
  const details = await rig.details();
  const replace = details.find((item) => item.name === 'replace_external_cs2');
  const start = details.find((item) => item.name === 'start_managed_cs2');
  expect(replace?.args).toMatchObject({
    expectedPid: external.pid,
    expectedCreated: external.created,
    expectedRevision: 'revision-1',
  });
  expect(typeof replace?.args.preparationId).toBe('string');
  expect(start?.args.preparationId).toBe(replace?.args.preparationId);
  expect(details.indexOf(replace!)).toBeLessThan(details.indexOf(start!));
});

test('capture failure retry retains the transaction and does not close or restart CS2 again', async ({
  page,
}) => {
  const rig = await setup(page, {
    capture: 'fail-once',
    external: { pid: 2357, created: 'creation-marker' },
  });
  await page.getByRole('button', { name: '启动工作台' }).click();
  await expect(page.locator('output')).toContainText('游戏采集初始化失败');
  await page.getByRole('button', { name: '启动工作台' }).click();
  await expect(page.locator('output')).toHaveText('confirmed');
  const details = await rig.details();
  expect(details.filter((item) => item.name === 'preflight_cs2_replacement')).toHaveLength(1);
  expect(details.filter((item) => item.name === 'replace_external_cs2')).toHaveLength(1);
  expect(details.filter((item) => item.name === 'start_managed_cs2')).toHaveLength(1);
  expect(rig.captureBodies).toHaveLength(2);
  expect(rig.captureBodies.map(({ transactionId }) => transactionId)).toEqual(
    rig.warmups.map(({ transactionId }) => transactionId),
  );
  const replace = details.find((item) => item.name === 'replace_external_cs2');
  const start = details.find((item) => item.name === 'start_managed_cs2');
  expect(start?.args.preparationId).toBe(replace?.args.preparationId);
});

test('returning from hidden presents the workbench without configuring or restarting', async ({
  page,
}) => {
  const rig = await setup(page, { hidden: true });
  await page.getByRole('button', { name: '启动工作台' }).click();
  await expect(page.locator('output')).toHaveText('confirmed');
  expect(rig.requests.filter((path) => path.startsWith('/operator/obs/'))).toHaveLength(0);
  const calls = await rig.calls();
  expect(calls).toContain('present_production');
  expect(calls).not.toContain('replace_external_cs2');
  expect(calls).not.toContain('start_managed_cs2');
  expect(calls).not.toContain('ensure_gsi');
});

test('leaving during preparation aborts and restores video without launching', async ({ page }) => {
  const rig = await setup(page, { holdEnsure: true });
  await page.getByRole('button', { name: '启动工作台' }).click();
  await expect.poll(() => rig.requests.includes('/operator/obs/ensure')).toBe(true);
  await page.evaluate(() => window.dispatchEvent(new PopStateEvent('popstate')));
  rig.releaseEnsure();
  await expect
    .poll(() => rig.requests.filter((path) => path === '/operator/obs/video-restore').length)
    .toBe(1);
  const calls = await rig.calls();
  expect(calls).not.toContain('start_managed_cs2');
  expect(calls).not.toContain('present_production');
});

test('a scene configuration failure restores video and does not close or start CS2', async ({
  page,
}) => {
  const rig = await setup(page, { failEnsure: true });
  await page.getByRole('button', { name: '启动工作台' }).click();
  await expect(page.locator('output')).toContainText('场景自动配置失败');
  expect(rig.requests.filter((path) => path === '/operator/obs/video-restore')).toHaveLength(1);
  const calls = await rig.calls();
  expect(calls).not.toContain('replace_external_cs2');
  expect(calls).not.toContain('start_managed_cs2');
  expect(calls).not.toContain('present_production');
});

test('active OBS output blocks before changing or stopping the game or stream', async ({
  page,
}) => {
  const rig = await setup(page, { activeOutput: true });
  await page.getByRole('button', { name: '启动工作台' }).click();
  await expect(page.locator('output')).toContainText('直播正在进行');
  expect(rig.requests).not.toContain('/operator/obs/output');
  expect(rig.requests).not.toContain('/operator/obs/video-prepare');
  const calls = await rig.calls();
  expect(calls).not.toContain('replace_external_cs2');
  expect(calls).not.toContain('start_managed_cs2');
});

test('shared OBS readiness blocks entry even when the findings list is empty', async ({ page }) => {
  const rig = await setup(page, { readinessBlocked: true });
  await page.getByRole('button', { name: '启动工作台' }).click();
  await expect(page.locator('output')).toContainText('OBS 音频来源尚未就绪');
  expect(await rig.calls()).not.toContain('replace_external_cs2');
  expect(await rig.calls()).not.toContain('start_managed_cs2');
  expect(rig.requests).toContain('/operator/obs/video-restore');
});

test('a persistently zero-sized capture never enters the workbench', async ({ page }) => {
  const rig = await setup(page, { capture: 'zero' });
  await page.clock.install();
  await page.getByRole('button', { name: '启动工作台' }).click();
  await expect.poll(() => rig.requests.includes('/operator/obs/capture-initialization')).toBe(true);
  await page.clock.fastForward(61_000);
  await expect(page.locator('output')).toContainText('0×0');
  expect(rig.requests).not.toContain('/operator/production');
  expect(await rig.calls()).not.toContain('present_production');
  expect(rig.requests.filter((path) => path === '/operator/obs/video-restore')).toHaveLength(1);
  expect(
    rig.requests.filter((path) => path === '/operator/obs/capture-warmup-release'),
  ).toHaveLength(1);
});

test('an inactive or revoked warmup fails immediately and cleans up', async ({ page }) => {
  const rig = await setup(page, { capture: 'inactive' });
  await page.getByRole('button', { name: '启动工作台' }).click();
  await expect(page.locator('output')).toContainText('游戏采集准备已失效');
  expect(rig.captureBodies).toHaveLength(1);
  expect(rig.requests).toContain('/operator/obs/capture-warmup-release');
  expect(rig.requests).not.toContain('/operator/production');
});

test('leaving while capture is checked releases the warmup and never enters', async ({ page }) => {
  const rig = await setup(page, { holdCapture: true });
  await page.getByRole('button', { name: '启动工作台' }).click();
  await expect.poll(() => rig.requests.includes('/operator/obs/capture-initialization')).toBe(true);
  await page.evaluate(() => window.dispatchEvent(new PopStateEvent('popstate')));
  rig.releaseCapture();
  await expect.poll(() => rig.requests.includes('/operator/obs/capture-warmup-release')).toBe(true);
  expect(rig.requests).not.toContain('/operator/production');
  expect(await rig.calls()).not.toContain('present_production');
});

test('a failed warmup release blocks entry and surfaces the cleanup issue', async ({ page }) => {
  const rig = await setup(page, { failWarmupRelease: true });
  await page.getByRole('button', { name: '启动工作台' }).click();
  await expect(page.locator('output')).toContainText('临时捕获来源清理待完成');
  expect(rig.requests).not.toContain('/operator/production');
  expect(await rig.calls()).not.toContain('present_production');
});

test('cancelling while warmup is released does not start the camera or enter', async ({ page }) => {
  const rig = await setup(page, { holdWarmupRelease: true });
  await page.getByRole('button', { name: '启动工作台' }).click();
  await expect.poll(() => rig.requests.includes('/operator/obs/capture-warmup-release')).toBe(true);
  await page.evaluate(() => window.dispatchEvent(new PopStateEvent('popstate')));
  rig.releaseWarmup();
  await expect(page.locator('output')).toHaveText('cancelled');
  expect(await rig.calls()).toContain('cancel_cs2_preparation');
  expect(await rig.calls()).not.toContain('begin_managed_camera');
  expect(rig.requests).not.toContain('/operator/production');
});
