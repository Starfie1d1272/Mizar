import { expect, test } from './companion-isolation.js';
import {
  DEFAULT_PLACEMENTS,
  getBuiltinResolvedPreset,
} from '../../packages/hud-config/src/index.js';
import stats from '../fixtures/rivalhub-provider-stats-v1.json' with { type: 'json' };

const visual = { kind: 'builtin', id: 'pulse', apiVersion: 1 };
const sceneNames = [
  'waiting',
  'matchup',
  'bp',
  'halftime',
  'map_result',
  'intermap',
  'match_result',
];
const background = {
  resource: { id: 'local:mizar-pack:example', version: '1.0.0', digest: 'a'.repeat(64) },
  fileId: 'background',
};

test('statistics follow scene appearance through rotation, standalone and failed assets', async ({
  page,
}, testInfo) => {
  let scene = 'waiting';
  let manual = false;
  let revision = 1;
  let assetRevision = 1;
  let color = '#192837';
  let palette = {
    blue: '#3060f0',
    gold: '#e0a020',
    white: '#eeeeee',
    muted: '#999999',
    shell: '#223344',
  };
  let hudColor = '#123456';
  let hudVisual = 'legacy';
  let failImage = false;
  const display = () => ({
    activeRevision: `r${revision}`,
    hud: {
      renderer: 'native',
      config: getBuiltinResolvedPreset(),
      overlays: {
        pause: { enabled: true, visual: hudVisual },
        chat: { enabled: true, placement: DEFAULT_PLACEMENTS['team-t-rail'] },
      },
      accent: { source: 'fixed', value: hudColor },
    },
    program: {
      scenes: Object.fromEntries(sceneNames.map((id) => [id, visual])),
      tokens: {
        'pulse.canvas': color,
        'pulse.blue': palette.blue,
        'pulse.gold': palette.gold,
        'pulse.white': palette.white,
        'pulse.muted': palette.muted,
        'pulse.shell': palette.shell,
      },
      assets: { 'pulse.background': { ...background, fileId: `background${assetRevision}` } },
    },
  });
  const presentation = {
    schemaVersion: 'mizar.program-presentation.v1',
    packageId: 'builtin:mizar-default',
    match: { matchId: stats.matchId, competition: null, format: 'bo3', stage: null },
    series: null,
    halftime: null,
    completed: [],
    eventLogoUrl: null,
    scheduledAt: null,
    previous: null,
    next: null,
  };
  await page.route('**/local/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/local/v1/broadcast-assets')
      return route.fulfill(
        failImage
          ? { status: 503 }
          : {
              status: 200,
              contentType: 'image/svg+xml',
              body: `<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080"><rect width="1920" height="1080" fill="${color}"/><path d="M0 1080L1920 300V1080Z" fill="#1b2738" opacity=".4"/></svg>`,
            },
      );
    if (path === '/local/v1/broadcast-display-config') return route.fulfill({ json: display() });
    if (path === '/local/v1/broadcast-stats') return route.fulfill({ json: stats });
    if (path === '/local/v1/program-presentation') return route.fulfill({ json: presentation });
    if (path === '/local/v1/program-scenes')
      return route.fulfill({
        json: {
          schemaVersion: 'mizar.program-scenes.v1',
          active: scene,
          revision: '1',
          available: [],
          blocked: {},
          director: {
            mode: manual ? 'manual' : 'auto',
            next: null,
            reason: null,
            introDurationMs: 6000,
            sceneElapsedMs: 0,
          },
        },
      });
    return route.fulfill({ status: 503 });
  });
  await page.clock.install();
  await page.goto('/program/waiting');
  await expect(page.locator('.program-scene--waiting')).toBeVisible();
  const sceneColors = (selector: string) =>
    page
      .locator(selector)
      .evaluate((node) =>
        Object.fromEntries(
          ['canvas', 'blue', 'gold', 'white', 'muted', 'shell'].map((name) => [
            name,
            getComputedStyle(node).getPropertyValue(`--mizar-broadcast-pulse-${name}`).trim(),
          ]),
        ),
      );
  expect(await sceneColors('.program-scene--waiting')).toEqual({ canvas: color, ...palette });
  const initialSceneBackground = await page
    .locator('.program-scene--waiting')
    .evaluate((node) => getComputedStyle(node).backgroundImage);
  await page.clock.fastForward(20_100);
  await expect(page.locator('.stats-insert')).toBeVisible();
  const canvas = page.locator('.stats-insert');
  const readColor = () =>
    canvas.evaluate((node) =>
      getComputedStyle(node).getPropertyValue('--mizar-broadcast-pulse-canvas').trim(),
    );
  const readPalette = () =>
    canvas.evaluate((node) =>
      Object.fromEntries(
        ['canvas', 'blue', 'gold', 'white', 'muted', 'shell'].map((name) => [
          name,
          getComputedStyle(node).getPropertyValue(`--mizar-broadcast-pulse-${name}`).trim(),
        ]),
      ),
    );
  expect(await readColor()).toBe(color);
  expect(await readPalette()).toEqual({ canvas: color, ...palette });
  expect(await canvas.evaluate((node) => getComputedStyle(node).backgroundImage)).toContain(
    'broadcast-assets',
  );
  expect(await canvas.evaluate((node) => getComputedStyle(node).backgroundImage)).toBe(
    initialSceneBackground,
  );
  await page.screenshot({ path: testInfo.outputPath('waiting.png') });
  const waitingBackground = await canvas.evaluate((node) => getComputedStyle(node).backgroundImage);
  hudColor = '#ff00ff';
  revision++;
  await page.clock.runFor(800);
  expect(await readColor()).toBe(color);
  expect(await readPalette()).toEqual({ canvas: color, ...palette });
  expect(await canvas.evaluate((node) => getComputedStyle(node).backgroundImage)).toBe(
    waitingBackground,
  );
  manual = true;
  await page.clock.runFor(500);
  await expect(canvas).toHaveCount(0);
  manual = false;
  scene = 'intermap';
  color = '#3b1a18';
  palette = {
    blue: '#40a0f0',
    gold: '#ffc640',
    white: '#ffffff',
    muted: '#bbbbbb',
    shell: '#3b2838',
  };
  assetRevision++;
  revision++;
  await page.goto('/program/intermap');
  await expect(page.locator('.program-scene--intermap')).toBeVisible();
  expect(await sceneColors('.program-scene--intermap')).toEqual({ canvas: color, ...palette });
  const intermapBackground = await page
    .locator('.program-scene--intermap')
    .evaluate((node) => getComputedStyle(node).backgroundImage);
  await page.clock.fastForward(20_100);
  await expect(canvas).toBeVisible();
  expect(await readColor()).toBe(color);
  expect(await readPalette()).toEqual({ canvas: color, ...palette });
  expect(await canvas.evaluate((node) => getComputedStyle(node).backgroundImage)).toBe(
    intermapBackground,
  );
  await page.screenshot({ path: testInfo.outputPath('intermap.png') });
  hudVisual = 'unsupported-hud-visual';
  revision++;
  await page.goto('/program/stats');
  await expect(canvas).toBeVisible();
  expect(await readColor()).toBe(color);
  expect(await readPalette()).toEqual({ canvas: color, ...palette });
  await page.screenshot({ path: testInfo.outputPath('standalone.png') });
  await page.goto('/program/stats?card=PLAYER%20ATTRIBUTES');
  await expect(canvas.locator('.stats-insert__radar')).toBeVisible();
  const sides = canvas.locator('.stats-insert__radar polygon[stroke-width="3"]');
  await expect(sides.nth(0)).toHaveAttribute('stroke', 'var(--mizar-broadcast-pulse-blue)');
  await expect(sides.nth(1)).toHaveAttribute('stroke', 'var(--mizar-broadcast-pulse-gold)');
  await expect(sides.nth(1)).toHaveAttribute('stroke-dasharray', '10 6');
  await page.screenshot({ path: testInfo.outputPath('radar.png') });
  const oldBackground = await canvas.evaluate((node) => getComputedStyle(node).backgroundImage);
  color = '#008800';
  revision++;
  assetRevision++;
  failImage = true;
  await page.clock.runFor(1000);
  expect(await readColor()).toBe('#3b1a18');
  expect(await canvas.evaluate((node) => getComputedStyle(node).backgroundImage)).toBe(
    oldBackground,
  );
  failImage = false;
  revision++;
  assetRevision++;
  await page.goto('/program/intermap');
  await expect(page.locator('.program-scene--intermap')).toBeVisible();
  await page.clock.fastForward(20_100);
  await expect(canvas).toBeVisible();
  scene = 'gameplay';
  await page.clock.runFor(500);
  await expect(canvas).toHaveCount(0);
});
