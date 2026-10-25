import { radarSnapshotSchema } from '../../packages/protocol/src/radar.js';
import { expect, test } from './companion-isolation.js';
import { readFileSync } from 'node:fs';
import type { WebSocketRoute } from '@playwright/test';
import {
  assistSnapshotSchema,
  DEFAULT_OBSERVER_SETTINGS,
} from '../../packages/protocol/src/assist.js';
import {
  ASSIST_SCHEMA_VERSION,
  LOCAL_PROTOCOL_VERSION,
} from '../../packages/protocol/src/version.js';
import { programSnapshotSchema } from '../../packages/protocol/src/program.js';
test('keeps the full-width square radar across private hint states and desktop sizes', async ({
  page,
}, testInfo) => {
  const fixtures = JSON.parse(
    readFileSync(
      'apps/web/src/program/fixtures/generated/epl-program-fixtures.generated.json',
      'utf8',
    ),
  ) as { fixtures: Record<string, { snapshot: unknown }> };
  const program = programSnapshotSchema.parse(fixtures.fixtures['epl-live']!.snapshot);
  await page.routeWebSocket('**/local/v1/program', (ws) => ws.send(JSON.stringify(program)));
  const snapshot = assistSnapshotSchema.parse({
    type: 'snapshot',
    protocolVersion: LOCAL_PROTOCOL_VERSION,
    channel: 'assist',
    schemaVersion: ASSIST_SCHEMA_VERSION,
    channelSeq: 1,
    cursor: program.cursor,
    payload: { availability: 'unavailable' },
  });
  let socket: WebSocketRoute | undefined;
  await page.routeWebSocket('**/local/v1/assist', (ws) => {
    socket = ws;
    ws.send(JSON.stringify(snapshot));
  });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const radarFixtures = JSON.parse(
    readFileSync(
      'apps/web/src/program/fixtures/generated/real-radar-fixtures.generated.json',
      'utf8',
    ),
  ) as { fixtures: Record<string, { samples: { snapshot: unknown }[] }> };
  const radarFrame = radarSnapshotSchema.parse(
    radarFixtures.fixtures['dense-utility']!.samples[0]!.snapshot,
  );
  program.payload.map.name = radarFrame.payload.mapName;
  await page.routeWebSocket('**/local/v1/radar', (ws) => ws.send(JSON.stringify(radarFrame)));
  await page.route('**/local/v1/music', (route) =>
    route.fulfill({ json: { status: { held: true, bgm: null, stinger: null, message: null } } }),
  );
  await page.setViewportSize({ width: 480, height: 1080 });
  await page.clock.install();
  await page.goto('/workspace/left');
  await page.clock.pauseAt(new Date(Date.now() + 1000));
  await expect(page.locator('.workspace-radar canvas')).toBeVisible();
  await page.clock.runFor(1000);
  const initialMap = await page.locator('.workspace-radar__picture').boundingBox();
  expect(initialMap!.width).toBe(480);
  expect(initialMap!.height).toBe(480);
  await expect(page.locator('.workspace-brand')).toHaveCount(0);
  await expect(page.getByText('比赛雷达', { exact: true })).toHaveCount(0);
  const card = page.getByRole('region', { name: '私有观察辅助' });
  await expect(card).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('workspace-standard.png') });
  snapshot.channelSeq++;
  snapshot.payload = {
    availability: 'available',
    observer: {
      state: 'ready',
      expectedDelaySeconds: 120,
      leadSeconds: 7,
      measuredDelaySeconds: 120,
      hints: [
        {
          id: 'synthetic-private',
          remainingSeconds: 7,
          attacker: { name: 'Example attacker with a long nickname', observerSlot: 2 },
          victim: { name: 'Example victim', observerSlot: 7 },
        },
      ],
    },
  };
  socket!.send(JSON.stringify(assistSnapshotSchema.parse(snapshot)));
  await expect(card).toContainText('7 秒后');
  await expect(card.locator('kbd')).toHaveText(['3', '8']);
  const radar = await page.locator('.workspace-radar').boundingBox(),
    hint = await card.boundingBox();
  expect(radar).not.toBeNull();
  expect(hint).not.toBeNull();
  expect(hint!.y).toBeGreaterThanOrEqual(radar!.y + radar!.height - 1);
  await page.screenshot({ path: testInfo.outputPath('workspace-private-hints.png') });
  expect(await page.locator('.workspace-radar__picture').boundingBox()).toEqual(initialMap);
  await expect(page.getByText('即将发生', { exact: true })).toHaveCount(0);
  snapshot.payload.observer!.hints = Array.from({ length: 3 }, (_, i) => ({
    ...snapshot.payload.observer!.hints[0]!,
    id: `layout-${i}`,
  }));
  snapshot.channelSeq++;
  socket!.send(JSON.stringify(snapshot));
  await expect(card.locator('li')).toHaveCount(3);
  expect(await card.locator('ol').evaluate((e) => e.scrollHeight <= e.clientHeight)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('workspace-private-hints-three.png') });
  snapshot.payload.observer!.hints = Array.from({ length: 6 }, (_, i) => ({
    ...snapshot.payload.observer!.hints[0]!,
    id: `layout-${i}`,
  }));
  snapshot.channelSeq++;
  socket!.send(JSON.stringify(snapshot));
  await expect(card.locator('li')).toHaveCount(6);
  for (const viewport of [
    { width: 480, height: 1080 },
    { width: 640, height: 1440 },
    { width: 960, height: 2160 },
  ]) {
    await page.setViewportSize(viewport);
    await expect
      .poll(async () => (await page.locator('.workspace-radar__picture').boundingBox())!.width)
      .toBe(viewport.width);
    const fullMap = (await page.locator('.workspace-radar__picture').boundingBox())!;
    expect(Math.abs(fullMap.height - viewport.width)).toBeLessThan(1);
    expect(fullMap.y).toBe(0);
    const mapCanvas = (await page.locator('.workspace-radar canvas').boundingBox())!;
    expect(Math.abs(mapCanvas.width - mapCanvas.height)).toBeLessThan(1);
    expect(mapCanvas.width).toBeGreaterThanOrEqual(viewport.width - 4);
    const confidence = (await page.getByRole('region', { name: 'OBS 画面确认' }).boundingBox())!;
    expect(confidence.y + confidence.height).toBe(viewport.height);
    const details = (await page.locator('.workspace-left__context').boundingBox())!;
    expect(details.y + details.height).toBeLessThanOrEqual(confidence.y);
    const hintsBox = (await card.boundingBox())!;
    expect(details.y).toBeGreaterThanOrEqual(hintsBox.y + hintsBox.height);
    expect(details.height).toBeGreaterThan(0);
    const context = page.locator('.workspace-context');
    const meta = context.locator('.workspace-context__meta');
    const actions = context.locator('.workspace-context__actions');
    const metaBox = (await meta.boundingBox())!;
    const actionBox = (await actions.boundingBox())!;
    expect(actionBox.y).toBeGreaterThanOrEqual(metaBox.y + metaBox.height);
    expect(await context.evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true);
    const buttons = await actions.getByRole('button').all();
    for (let i = 1; i < buttons.length; i++) {
      const a = (await buttons[i - 1]!.boundingBox())!;
      const b = (await buttons[i]!.boundingBox())!;
      expect(b.x >= a.x + a.width - 1 || b.y >= a.y + a.height - 1).toBe(true);
    }
    const list = card.locator('ol');
    expect(await list.evaluate((e) => e.scrollHeight > e.clientHeight)).toBe(true);
    const rows = await list.locator('li').all();
    const listBox = (await list.boundingBox())!;
    const thirdBox = (await rows[2]!.boundingBox())!;
    expect(thirdBox.y + thirdBox.height).toBeLessThanOrEqual(listBox.y + listBox.height + 1);
  }
  await page.setViewportSize({ width: 480, height: 1080 });
  await page.screenshot({ path: testInfo.outputPath('workspace-private-hints-six.png') });
  await page.getByRole('button', { name: '恢复自动音乐' }).scrollIntoViewIfNeeded();
  const musicBox = (await page.getByRole('button', { name: '恢复自动音乐' }).boundingBox())!;
  const obsBox = (await page.getByRole('region', { name: 'OBS 画面确认' }).boundingBox())!;
  expect(musicBox.y + musicBox.height).toBeLessThanOrEqual(obsBox.y);
  await page.clock.runFor(6000);
  await expect(card).toContainText('1 秒后');
  await page.clock.runFor(1000);
  await expect(card).toHaveCount(0);
  expect(await page.locator('.workspace-radar__picture').boundingBox()).toEqual(initialMap);
  snapshot.channelSeq++;
  snapshot.payload = { availability: 'unavailable' };
  socket!.send(JSON.stringify(snapshot));
  await expect(card).toHaveCount(0);
  expect(errors).toEqual([]);
});
test('observer settings show saved timing and support keyboard operation', async ({
  page,
}, testInfo) => {
  await page.route('**/local/v1/observer-assist', (route) =>
    route.fulfill({
      json: { settings: { ...DEFAULT_OBSERVER_SETTINGS, enabled: true }, connection: null },
    }),
  );
  await page.goto('/settings?tab=observer');
  await expect(page.getByRole('spinbutton', { name: '两路预期延迟差（秒）' })).toHaveValue('120');
  await expect(page.getByRole('spinbutton', { name: '提示提前时间（秒）' })).toHaveValue('7');
  await expect(page.getByRole('spinbutton')).toHaveCount(2);
  const toggle = page.getByRole('checkbox', { name: '启用私有观察辅助', exact: true });
  await toggle.focus();
  await page.keyboard.press('Space');
  await expect(toggle).not.toBeChecked();
  await page.keyboard.press('Space');
  await expect(toggle).toBeChecked();
  await page.screenshot({ path: testInfo.outputPath('observer-settings.png') });
  let saved: unknown;
  await page.route('**/operator/observer-assist', async (route) => {
    saved = route.request().postDataJSON();
    await route.fulfill({ json: { ok: true } });
  });
  await page.getByRole('spinbutton', { name: '两路预期延迟差（秒）' }).fill('90');
  await page.getByRole('spinbutton', { name: '提示提前时间（秒）' }).fill('5');
  await page.getByRole('button', { name: '保存观察辅助设置' }).click();
  await expect(page.getByText('观察辅助设置已保存。')).toBeVisible();
  expect(saved).toEqual({
    action: 'configure',
    settings: {
      ...DEFAULT_OBSERVER_SETTINGS,
      enabled: true,
      expectedDelaySeconds: 90,
      leadSeconds: 5,
    },
  });
});

// Native calls below are browser contract doubles, not Windows/CS2/OBS evidence.
test('enters standard and MulNX without an address, then confirms from the workbench', async ({
  page,
  context,
}, testInfo) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  for (const useMulnx of [false, true]) {
    let view = {
      revision: '10000000-0000-4000-8000-000000000001',
      settings: { ...DEFAULT_OBSERVER_SETTINGS, enabled: true },
      gameAutomation: { autoConnect: true, hideGameHud: true },
      connection: null as null | { earlyEndpoint: string; programEndpoint: string },
    };
    let production = { mode: 'preparation', revision: 'connection-test', canEnter: true };
    const writes: Record<string, unknown>[] = [];
    let omitSavedRevision = false;
    await page.route('**/local/v1/observer-assist', (route) => route.fulfill({ json: view }));
    await page.route('**/local/v1/observer', (route) =>
      route.fulfill({ json: { active: false, pending: false, failed: false } }),
    );
    await page.route('**/operator/observer-assist', (route) => {
      const body = route.request().postDataJSON() as {
        action: string;
        connection: { earlyEndpoint: string; programEndpoint: string };
      };
      writes.push(body);
      if (body.action === 'connection') {
        const next = body.connection.programEndpoint === '127.0.0.1:27026' ? '2' : '3';
        view = {
          ...view,
          revision: `10000000-0000-4000-8000-00000000000${next}`,
          connection: body.connection,
        };
      }
      return route.fulfill({ json: omitSavedRevision ? { ...view, revision: undefined } : view });
    });
    await page.route('**/local/v1/production', (route) => route.fulfill({ json: production }));
    await page.route('**/operator/production', (route) => {
      production = { ...production, mode: 'live' };
      return route.fulfill({ json: production });
    });
    await page.route('**/operator/obs/ensure', (route) => route.fulfill({ json: { ok: true } }));
    await page.route('**/local/v1/demo-test', (route) =>
      route.fulfill({ json: { active: false } }),
    );
    await page.route('**/local/v1/obs', (route) =>
      route.fulfill({ json: { connection: 'connected', findings: [], streaming: false } }),
    );
    await page.addInitScript((preferMulnx) => {
      const host = window as typeof window & {
        nativeCalls: string[];
        openedPaths: string[];
        failConnection: boolean;
        __TAURI_INTERNALS__: {
          invoke: (name: string, args?: Record<string, unknown>) => Promise<unknown>;
        };
      };
      host.nativeCalls = [];
      host.openedPaths = [];
      host.failConnection = false;
      let running = false;
      host.__TAURI_INTERNALS__ = {
        invoke: async (name, args) => {
          await Promise.resolve();
          host.nativeCalls.push(
            name === 'observer_command' ? `${name}/${String(args?.action)}` : name,
          );
          if (name === 'open_main') host.openedPaths.push(String(args?.path));
          if (name === 'observer_command' && host.failConnection)
            throw new Error('节目或早源操作失败');
          if (name === 'observer_command') {
            if (
              ![
                '10000000-0000-4000-8000-000000000002',
                '10000000-0000-4000-8000-000000000003',
              ].includes(String(args?.expectedRevision))
            )
              throw new Error('saved connection revision was not forwarded');
            return { useMulnx: preferMulnx };
          }
          if (name === 'cs2_config_status')
            return {
              preferMulnx,
              running,
              pending: false,
              qualityPreset: 'high',
              frameRateLimit: 60,
            };
          if (name === 'start_managed_cs2') {
            running = true;
            return true;
          }
          if (name === 'launch_mulnx') {
            running = true;
            return { pid: 42, created: '134000000000000000' };
          }
          if (name === 'gsi_status') return { detected: true, installed: true, conflict: false };
          if (name === 'workspace_exit_status') return { busy: false };
          return null;
        },
      };
    }, useMulnx);
    const calls = () =>
      page.evaluate(() => (window as typeof window & { nativeCalls: string[] }).nativeCalls);
    await page.goto('/settings?tab=observer');
    await page.getByRole('button', { name: '打开直播工作台', exact: true }).click();
    await expect.poll(async () => (await calls()).includes('present_production')).toBe(true);
    expect(await calls()).toContain(useMulnx ? 'launch_mulnx' : 'start_managed_cs2');
    expect(await calls()).not.toContain('observer_command/start-configured');
    expect(writes).toHaveLength(0);
    await expect(page.getByRole('dialog', { name: '本图观战连接', exact: true })).not.toBeVisible();
    await page.goto('/workspace/left');
    const control = page.getByRole('button', { name: /本图连接 ·/ });
    await expect(control).toContainText('未连接');
    await control.click();
    const dialog = page.getByRole('dialog', { name: '本图观战连接', exact: true });
    await expect(dialog).toBeVisible();
    await dialog
      .getByRole('textbox', { name: '本图观战连接', exact: true })
      .fill('connect 127.0.0.1:27025;password synthetic');
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    expect(writes).toHaveLength(0);
    await expect(page.locator('.workspace-radar')).toBeVisible();
    await control.click();
    await expect(dialog.getByRole('textbox', { name: '本图观战连接', exact: true })).toHaveValue(
      'connect 127.0.0.1:27025;password synthetic',
    );
    await expect(dialog).toContainText('游戏节目源：127.0.0.1:27026');
    await dialog.getByRole('button', { name: '复制节目源连接命令' }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      'password "synthetic"; connect 127.0.0.1:27026',
    );
    expect(writes).toHaveLength(0);
    omitSavedRevision = true;
    await dialog.getByRole('button', { name: '确认本图连接', exact: true }).click();
    await expect(dialog).toContainText('本图连接修订未确认');
    expect(await calls()).not.toContain('observer_command/start-configured');
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    omitSavedRevision = false;
    await control.click();
    await dialog
      .getByRole('textbox', { name: '本图观战连接', exact: true })
      .fill('connect 127.0.0.1:27025;password synthetic');
    await page.evaluate(() => {
      (window as typeof window & { failConnection: boolean }).failConnection = true;
    });
    await dialog.getByRole('button', { name: '确认本图连接', exact: true }).click();
    await expect(dialog).toContainText('节目或早源操作失败');
    await expect(page.locator('.workspace-radar')).toBeVisible();
    expect(await calls()).not.toContain('finish_workspace');
    expect(await calls()).not.toContain('present_production');
    expect(await calls()).not.toContain('start_managed_cs2');
    await page.setViewportSize({ width: 480, height: 1080 });
    expect(
      await dialog.evaluate(
        (el) =>
          el.scrollWidth <= el.clientWidth && el.getBoundingClientRect().right <= window.innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath(
        useMulnx ? 'connection-mulnx-failure.png' : 'connection-standard-failure.png',
      ),
    });
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.evaluate(() => {
      (window as typeof window & { failConnection: boolean }).failConnection = false;
    });
    await dialog.getByRole('button', { name: '重试本图连接', exact: true }).dblclick();
    await expect(dialog).toContainText(
      useMulnx ? '本图连接操作已提交' : '当前游戏没有已验证的 MulNX 控制资格',
    );
    expect(
      (await calls()).filter((call) => call === 'observer_command/start-configured'),
    ).toHaveLength(2);
    expect(writes[0]).toMatchObject({
      action: 'connection',
      connection: { earlyEndpoint: '127.0.0.1:27025', programEndpoint: '127.0.0.1:27026' },
    });
    await dialog.getByRole('button', { name: '完成', exact: true }).click();
    await expect(dialog).not.toBeVisible();
    // Map two uses new credentials and both endpoints without another game launch.
    await expect(control).toContainText('待连接');
    const mapOneWrites = writes.filter((body) => body.action === 'connection').length;
    await control.click();
    await dialog
      .getByRole('textbox', { name: '本图观战连接', exact: true })
      .fill('connect 127.0.0.2:27035;password second-map');
    await dialog.getByText('高级设置', { exact: true }).click();
    await dialog.getByRole('textbox', { name: '早源 IPv4:端口' }).fill('127.0.0.2:27035');
    await dialog.getByRole('textbox', { name: '节目源 IPv4:端口' }).fill('127.0.0.2:27036');
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    expect(writes.filter((body) => body.action === 'connection')).toHaveLength(mapOneWrites);
    expect(view.connection?.programEndpoint).toBe('127.0.0.1:27026');
    await control.click();
    await dialog.getByRole('button', { name: '复制节目源连接命令' }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      'password "second-map"; connect 127.0.0.2:27036',
    );
    await page.evaluate(() => {
      (window as typeof window & { failConnection: boolean }).failConnection = true;
    });
    await dialog.getByRole('button', { name: '确认本图连接', exact: true }).click();
    await expect(dialog).toContainText('节目或早源操作失败');
    expect(view.connection).toMatchObject({
      earlyEndpoint: '127.0.0.2:27035',
      programEndpoint: '127.0.0.2:27036',
    });
    await page.evaluate(() => {
      (window as typeof window & { failConnection: boolean }).failConnection = false;
    });
    await dialog.getByRole('button', { name: '重试本图连接', exact: true }).click();
    await expect(dialog.getByRole('button', { name: '完成', exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: '完成', exact: true }).click();
    expect(await calls()).not.toContain('finish_workspace');
    expect(await calls()).not.toContain('present_production');
    expect(await calls()).not.toContain('start_managed_cs2');
    expect(await calls()).not.toContain('launch_mulnx');
    await control.click();
    await dialog
      .getByRole('textbox', { name: '本图观战连接', exact: true })
      .fill('connect 127.0.0.3:27025;password third-map');
    await expect(dialog.getByRole('textbox', { name: '早源 IPv4:端口' })).not.toBeVisible();
    await expect(dialog.getByRole('button', { name: '复制节目源连接命令' })).toBeVisible();
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    await page.reload();
    await expect(control).toBeVisible();
    expect(await calls()).not.toContain('observer_command/start-configured');
    expect(await calls()).not.toContain('start_managed_cs2');
    expect(await calls()).not.toContain('launch_mulnx');
    expect(await calls()).not.toContain('cs2_console_status');
    expect(await calls()).not.toContain('set_cs2_console_capture');
    await page.goto('/workspace/dock');
    await page.getByRole('button', { name: '配置运镜', exact: true }).click();
    await expect
      .poll(() =>
        page.evaluate(() => (window as typeof window & { openedPaths: string[] }).openedPaths),
      )
      .toContain('/settings?tab=music&section=camera');
    await page.goto('/settings?tab=music&section=camera');
    await expect(page.getByRole('heading', { name: '运镜', exact: true })).toBeVisible();
  }
});
