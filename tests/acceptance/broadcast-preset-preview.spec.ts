import { expect, test } from '@playwright/test';
import {
  getBuiltinPreset,
  getBuiltinLayout,
  getBuiltinTheme,
} from '../../packages/hud-config/src/index.js';

const hudId = '00000000-0000-4000-8000-000000000001';
const programId = '00000000-0000-4000-8000-000000000002';
const presetId = '00000000-0000-4000-8000-000000000003';
const visual = { kind: 'builtin', id: 'pulse', apiVersion: 1 };
const hud = getBuiltinPreset();
const theme = getBuiltinTheme();
const view = {
  modules: [
    {
      id: hudId,
      kind: 'hud',
      schemaVersion: 1,
      revision: 'h1',
      name: 'HUD',
      origin: null,
      value: {
        renderer: { kind: 'native', id: 'mizar.hud', apiVersion: 1 },
        preset: hud,
        layout: getBuiltinLayout(),
        theme,
        overlays: {
          pause: { enabled: true, visual: 'legacy' },
          chat: { enabled: true, placement: 'auto' },
        },
        accent: { source: 'fixed', value: theme.brandColor },
      },
    },
    {
      id: programId,
      kind: 'program',
      schemaVersion: 1,
      revision: 'p1',
      name: 'Pulse',
      origin: null,
      value: {
        scenes: {
          waiting: visual,
          matchup: visual,
          bp: visual,
          halftime: visual,
          map_result: visual,
          intermap: visual,
          match_result: visual,
        },
        tokens: {},
        assets: {},
      },
    },
  ],
  presets: [
    {
      id: presetId,
      name: '测试方案',
      revision: 's1',
      bindings: [
        { kind: 'hud', mode: 'use', moduleId: hudId },
        { kind: 'program', mode: 'use', moduleId: programId },
        { kind: 'music', mode: 'off' },
        { kind: 'camera', mode: 'off' },
      ],
    },
  ],
  active: { revision: 'a1', sourcePreset: null, adjusted: false },
};

test('previews each saved scene without applying the scheme or requiring tools', async ({
  page,
}) => {
  let writes = 0;
  await page.route('**/local/v1/broadcast-presets', (route) => route.fulfill({ json: view }));
  await page.route('**/operator/broadcast-presets/**', (route) => {
    writes++;
    return route.fulfill({ status: 500 });
  });
  await page.goto('/packages');
  await page.getByRole('button', { name: '播出方案', exact: true }).click();
  await page.getByText('查看配置', { exact: true }).click();
  await expect(page.getByText('模拟画面 · 示例比赛数据')).toBeVisible();
  const frame = page.getByLabel('示例画面');
  await expect(frame.locator('[data-gameplay-hud]')).toHaveAttribute('data-hud-preset-id', hud.id);
  await expect(frame.locator('[data-hud-widget="radar"] canvas')).toBeVisible();
  const scene = page.getByLabel('节目场景');
  for (const [id, selector] of [
    ['waiting', '.program-scene--waiting'],
    ['matchup', '.program-scene--matchup'],
    ['bp', '.bp-scene'],
    ['halftime', '.program-scene--halftime'],
    ['map_result', '.program-scene--map_result'],
    ['intermap', '.program-scene--intermap'],
    ['match_result', '.program-scene--match_result'],
  ]) {
    await scene.selectOption(id);
    await expect(frame.locator(selector)).toBeVisible();
    if (id === 'waiting') {
      await expect(frame.locator('.waiting-label')).toHaveCSS('color', 'rgb(244, 248, 253)');
    }
  }
  expect(writes).toBe(0);
});
