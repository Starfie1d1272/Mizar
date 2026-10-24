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
test('private hints occupy the left radar section while off keeps the base workspace', async ({
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
  await page.goto('/workspace/left');
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
      displaySeconds: 10,
      measuredDelaySeconds: 120,
      hints: [
        {
          id: 'synthetic-private',
          remainingSeconds: 7,
          occurred: false,
          attacker: { name: 'Example attacker with a long nickname', observerSlot: 2 },
          victim: { name: 'Example victim', observerSlot: 7 },
        },
      ],
    },
  };
  socket!.send(JSON.stringify(assistSnapshotSchema.parse(snapshot)));
  await expect(card).toContainText('7.0 秒后');
  await expect(card.locator('kbd')).toHaveText(['3', '8']);
  const radar = await page.locator('.workspace-radar').boundingBox(),
    hint = await card.boundingBox();
  expect(radar).not.toBeNull();
  expect(hint).not.toBeNull();
  expect(hint!.y).toBeGreaterThanOrEqual(radar!.y + radar!.height - 1);
  await page.screenshot({ path: testInfo.outputPath('workspace-private-hints.png') });
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
  await expect(page.getByRole('spinbutton', { name: '提示总停留时间（秒）' })).toHaveValue('10');
  const toggle = page.getByRole('checkbox', { name: '启用私有观察辅助', exact: true });
  await toggle.focus();
  await page.keyboard.press('Space');
  await expect(toggle).not.toBeChecked();
  await page.keyboard.press('Space');
  await expect(toggle).toBeChecked();
  await page.screenshot({ path: testInfo.outputPath('observer-settings.png') });
});
