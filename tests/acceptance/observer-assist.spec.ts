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
