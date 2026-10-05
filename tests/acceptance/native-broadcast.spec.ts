import { readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { getBuiltinResolvedPreset } from '../../packages/hud-config/src/index.js';
import { programSnapshotSchema } from '../../packages/protocol/src/program.js';
import { expect, test } from './companion-isolation.js';

const artifact = JSON.parse(
  readFileSync(
    new URL(
      '../../apps/web/src/program/fixtures/generated/real-program-fixtures.generated.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as { fixtures: Record<string, { snapshot: unknown }> };
function sample(id: string) {
  return programSnapshotSchema.parse(artifact.fixtures[id]!.snapshot);
}
async function feed(page: Page, id: string) {
  const snapshot = sample(id);
  await page.routeWebSocket('**/local/v1/program', (socket) =>
    socket.send(JSON.stringify(snapshot)),
  );
  await page.goto('/program?hud-config=companion');
  await expect(page.locator('[data-gameplay-hud]')).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}

test('native default keeps fixed combat geometry through real freeze, damage, death and objective states', async ({
  page,
}) => {
  await page.route('**/local/v1/hud-config', (route) =>
    route.fulfill({
      json: { resolved: getBuiltinResolvedPreset(), etag: 'native', activeRevision: 'native' },
    }),
  );
  for (const id of [
    'real-live-rich',
    'real-post-explosion-freezetime',
    'real-planting',
    'real-planted',
    'real-defusing',
    'real-defused',
    'real-exploded',
  ]) {
    await feed(page, id);
    expect(await page.locator('.match-header__score-shell').boundingBox()).toEqual({
      x: 560,
      y: 24,
      width: 800,
      height: 80,
    });
    const alive = page.locator('.match-header__alive-matchup');
    if (await alive.count()) {
      // The fixed-width inherited panel must stay centered when the main bar changes width.
      await expect
        .poll(async () => {
          const box = (await alive.boundingBox())!;
          return Math.abs(box.x + box.width / 2 - 960);
        })
        .toBeLessThan(1);
    }
    const fuse = page.locator('.objective-center__fuse');
    if (await fuse.count()) {
      const track = (await fuse.boundingBox())!;
      expect(track.height).toBe(8);
      expect(track.y).toBe(112);
      expect(track.width).toBe(768);
      expect(track.x + track.width / 2).toBe(960);
      if (await alive.count())
        expect((await alive.boundingBox())!.y).toBeGreaterThan(track.y + track.height);
    }
    for (const logo of await page.locator('.match-header__series-map-picker').all()) {
      const bounds = (await logo.boundingBox())!;
      const art = (await logo.locator('..').boundingBox())!;
      expect(bounds.y).toBeGreaterThanOrEqual(art.y);
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(art.y + art.height);
    }
    const left = page.locator('.player-rail--left .player-rail__card');
    const right = page.locator('.player-rail--right .player-rail__card');
    await expect(left).toHaveCount(5);
    await expect(right).toHaveCount(5);
    await expect(page.locator('.player-rail__header').first()).toBeHidden();
    for (const rail of await page.locator('.player-rail').all()) {
      const summary = (await rail.locator('.player-rail__summary-slot').boundingBox())!;
      const first = (await rail.locator('.player-rail__card').first().boundingBox())!;
      expect(first.y - summary.y - summary.height).toBe(8);
    }
    for (let index = 0; index < 5; index++) {
      const a = (await left.nth(index).boundingBox())!;
      const b = (await right.nth(index).boundingBox())!;
      expect(a.y).toBe(558 + 84 * index);
      expect(b.y).toBe(a.y);
      expect(a.height).toBe(76);
      expect(b.width).toBe(a.width);
    }
    for (const card of await page.locator('.player-rail__card--dead').all()) {
      const paint = await card.evaluate((el) => {
        const body = el.querySelector('.player-rail__body')!;
        const plate = getComputedStyle(body, '::before');
        const nickname = el.querySelector('.player-rail__name')!.getBoundingClientRect();
        const state = el.querySelector('.player-rail__life-state')!.getBoundingClientRect();
        const kill = el.querySelector('.player-rail__round-kill-slot')!.getBoundingClientRect();
        const box = body.getBoundingClientRect();
        const width = parseFloat(plate.width);
        const left =
          el.getAttribute('data-physical-side') === 'left' ? box.left : box.right - width;
        return {
          lighter: width < box.width && parseFloat(plate.height) < box.height,
          nameFits: nickname.left >= left && nickname.right <= left + width,
          markFits: state.left >= left && state.right <= left + width,
          markSeparate: kill.right <= state.left || state.right <= kill.left,
        };
      });
      expect(paint).toEqual({ lighter: true, nameFits: true, markFits: true, markSeparate: true });
    }
    const names = await page.locator('.player-rail__name').evaluateAll((nodes) =>
      nodes.map((n) => ({
        width: n.clientWidth,
        scroll: n.scrollWidth,
        height: n.getBoundingClientRect().height,
      })),
    );
    expect(names.every((n) => n.width >= n.scroll && n.height >= 20)).toBe(true);
    for (const bar of await page.locator('[data-health-bar]').all())
      expect((await bar.boundingBox())!.height).toBe(7);
    const focus = page.locator('.focused-player');
    if (await focus.count()) expect((await focus.boundingBox())!.height).toBe(72);
    if (id === 'real-live-rich') {
      // A light ammo surface must explicitly override inherited white / muted text.
      const focusBox = (await focus.boundingBox())!;
      const ammoBox = (await page.locator('.focused-player__ammo').boundingBox())!;
      expect(ammoBox.width).toBeGreaterThanOrEqual(72);
      for (const text of await page
        .locator('.focused-player__ammo > strong, .focused-player__ammo > span')
        .all()) {
        const bounds = (await text.boundingBox())!;
        expect(bounds.y).toBeGreaterThanOrEqual(focusBox.y + 8);
        expect(bounds.y + bounds.height).toBeLessThanOrEqual(focusBox.y + focusBox.height - 8);
      }
      const ratios = await focus.evaluate((el) => {
        const context = document.createElement('canvas').getContext('2d')!;
        const luminance = (color: string) => {
          context.fillStyle = color;
          context.fillRect(0, 0, 1, 1);
          const rgb = [...context.getImageData(0, 0, 1, 1).data].slice(0, 3).map((c) => {
            const value = c / 255;
            return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
          });
          return rgb[0]! * 0.2126 + rgb[1]! * 0.7152 + rgb[2]! * 0.0722;
        };
        const surface = luminance(getComputedStyle(el).backgroundColor);
        return [
          ...el.querySelectorAll('.focused-player__ammo > strong, .focused-player__ammo > span'),
        ].map((text) => {
          const ink = luminance(getComputedStyle(text).color);
          return (Math.max(ink, surface) + 0.05) / (Math.min(ink, surface) + 0.05);
        });
      });
      expect(ratios).toHaveLength(2);
      expect(ratios.every((ratio) => ratio >= 4.5)).toBe(true);
    }
  }
});

test('native pause reuses factual owner, five rows and settings; stale Program does not keep a dock', async ({
  page,
}) => {
  const preset = getBuiltinResolvedPreset();
  await page.route('**/local/v1/hud-config', (route) =>
    route.fulfill({ json: { resolved: preset, etag: 'native', activeRevision: 'native' } }),
  );
  for (const [id, owner] of [
    ['real-timeout-ct', 'a'],
    ['real-timeout-t', 'b'],
    ['real-paused', 'unknown'],
    ['real-halftime-before', 'unknown'],
    ['real-halftime-after', 'unknown'],
  ]) {
    await feed(page, id!);
    await expect(page.locator('[data-broadcast-pause]')).toHaveAttribute(
      'data-pause-owner',
      owner!,
    );
    await expect(page.locator('[data-pause-player]')).toHaveCount(10);
    const bottom = await page.locator('.broadcast-pause__roster').first().boundingBox();
    expect(bottom!.y + bottom!.height).toBe(970);
    for (const used of await page
      .locator('.broadcast-pause__timeout-slots i[data-timeout-available="false"]')
      .all()) {
      const paint = await used.evaluate((el) => ({
        border: getComputedStyle(el).borderTopColor,
        background: getComputedStyle(el).backgroundColor,
        width: getComputedStyle(el).borderTopWidth,
      }));
      expect(paint.border).toBe('rgb(154, 168, 183)');
      expect(paint.background).toBe('rgba(0, 0, 0, 0)');
      expect(paint.width).toBe('1px');
    }
  }
  preset.widgets['top-score-bar'].settings.showTimeout = false;
  await feed(page, 'real-timeout-ct');
  await expect(page.locator('[data-broadcast-pause]')).toHaveCount(0);
  const stale = sample('real-paused');
  stale.payload.status.telemetry = 'stale';
  await page.routeWebSocket('**/local/v1/program', (socket) => socket.send(JSON.stringify(stale)));
  await page.reload();
  await expect(page.locator('[data-broadcast-pause]')).toHaveCount(0);
});

test('Waiting folds unavailable media and schedule; result page keeps original map and ten-player geometry', async ({
  page,
}) => {
  for (const variant of ['default', 'no-media', 'no-schedule', 'long-names', 'bo1', 'bo5']) {
    await page.goto(`/program/waiting?preview=1&variant=${variant}`);
    const hero = (await page.locator('.waiting-hero').boundingBox())!;
    if (variant === 'no-schedule') expect(hero.width).toBe(1680);
    else {
      const schedule = (await page.locator('.waiting-schedule').boundingBox())!;
      expect(schedule.x).toBeGreaterThan(hero.x + hero.width);
    }
    const names = await page
      .locator('.waiting-team strong')
      .evaluateAll((nodes) => nodes.map((n) => ({ y: n.getBoundingClientRect().y })));
    expect(Math.abs(names[0]!.y - names[1]!.y)).toBeLessThan(60);
  }
  for (const scene of ['halftime', 'intermap', 'match-result']) {
    await page.goto(`/program/${scene}?preview=1`);
    expect(await page.locator('.summary-players').boundingBox()).toEqual({
      x: 120,
      y: 360,
      width: 1680,
      height: 600,
    });
    await expect(page.locator('.summary-player')).toHaveCount(10);
  }
});

test('full and short Intro land on measured logo slots, missing media use names and reduced motion cancels movement', async ({
  page,
}) => {
  for (const variant of ['default', 'no-media', 'long-names']) {
    await page.goto(`/program/matchup?preview=1&variant=${variant}`);
    await page.evaluate(() => document.fonts.ready);
    await expect
      .poll(() =>
        page.locator('.intro-team--a').evaluate((el) => el.getAnimations({ subtree: true }).length),
      )
      .toBeGreaterThan(0);
    const movingSelector = (await page.locator('.intro-team--a img').count())
      ? '.intro-team--a img'
      : '.intro-team--a strong';
    for (const time of [1000, 3000]) {
      await page.locator('.intro-body').evaluate(
        (root, time) =>
          root.getAnimations({ subtree: true }).forEach((a) => {
            a.pause();
            a.currentTime = time;
          }),
        time,
      );
      const held = (await page.locator(movingSelector).boundingBox())!;
      // The complete Intro must keep its identity hold; easing must not warp the whole 6s timeline.
      expect(Math.abs(held.x + held.width / 2 - 530)).toBeLessThan(2);
    }
    // Pause the actual production animations at handoff; these are not recreated screenshot keyframes.
    await page.locator('.intro-body').evaluate((root) =>
      root.getAnimations({ subtree: true }).forEach((a) => {
        a.pause();
        a.currentTime = 5400;
      }),
    );
    const hasLogo = await page.locator('.intro-team--a img').count();
    const moving = page.locator(hasLogo ? '.intro-team--a img' : '.intro-team--a strong');
    const target = page.locator(
      hasLogo
        ? '[data-team-logo-slot="a"] img'
        : '[data-team-logo-slot="a"] .match-header__team-name',
    );
    const from = (await moving.boundingBox())!;
    const to = (await target.boundingBox())!;
    expect(Math.abs(from.x + from.width / 2 - to.x - to.width / 2)).toBeLessThan(2);
    expect(Math.abs(from.y + from.height / 2 - to.y - to.height / 2)).toBeLessThan(2);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect.poll(() => moving.evaluate((el) => el.getAnimations().length)).toBe(0);
    await expect(page.locator('.intro-art')).toBeHidden();
    await expect(page.locator('.intro-team--a')).toHaveCSS('clip-path', 'none');
    await page.emulateMedia({ reducedMotion: 'no-preference' });
  }
  await page.goto('/program/matchup?preview=1&intro=short');
  await expect(page.locator('.intro-map')).toBeHidden();
  await expect(page.locator('.intro-hud')).toHaveCSS('opacity', '1', { timeout: 3500 });
  await page.goto('/program/waiting?preview=1');
  await expect(page.locator('.intro-body')).toHaveCount(0);
});

test('native C4 prediction uses real replay damage and remains distinct from health; opt-outs and legacy envelopes work', async ({
  page,
}) => {
  const rows = readFileSync(
    new URL('../../apps/web/public/fixtures/ancient-round-03/replay/frames.jsonl', import.meta.url),
    'utf8',
  )
    .trim()
    .split('\n')
    .map((row) => JSON.parse(row) as { cursor: { sequence: number }; program: unknown });
  const snapshot = programSnapshotSchema.parse(
    rows.find((row) => row.cursor.sequence === 1158)!.program,
  );
  const preset = getBuiltinResolvedPreset();
  await page.route('**/local/v1/hud-config', (route) =>
    route.fulfill({ json: { resolved: preset, etag: 'native', activeRevision: 'native' } }),
  );
  await page.routeWebSocket('**/local/v1/program', (socket) =>
    socket.send(JSON.stringify(snapshot)),
  );
  await page.goto('/program?hud-config=companion');
  const prediction = page.locator('.player-rail__bomb-prediction[data-bomb-prediction="lethal"]');
  await expect(prediction).toHaveCount(1);
  await expect(prediction).toHaveAttribute('aria-label', /255 damage, 0 HP remaining/);
  const paint = await prediction.evaluate((el) => ({
    image: getComputedStyle(el).backgroundImage,
    height: el.getBoundingClientRect().height,
  }));
  expect(paint.image).toContain('repeating-linear-gradient');
  expect(paint.height).toBe(7);
  const card = prediction.locator('xpath=ancestor::*[contains(@class,"player-rail__card")]');
  await expect(card.locator('.player-rail__health-value')).toHaveText('73');
  await expect(page.locator('.player-rail__card[data-observed="true"]')).toHaveCSS(
    'outline-width',
    '1px',
  );
  preset.widgets['team-ct-rail'].settings.showBombPrediction = false;
  preset.widgets['team-t-rail'].settings.showBombPrediction = false;
  preset.widgets['focused-player'].settings.showMetrics = true;
  // A stored, current-version 360px envelope must remain usable, without silently moving it.
  delete preset.layout.widgets['focused-player'].size;
  await page.reload();
  await expect(prediction).toHaveCount(0);
  await expect(page.locator('.focused-player__metrics')).toBeVisible();
  const focus = (await page.locator('.focused-player').boundingBox())!;
  expect(focus.width).toBe(360);
  expect(focus.height).toBe(96);
  for (const part of [
    '.focused-player__vitals',
    '.focused-player__active',
    '.focused-player__ammo',
    '.focused-player__metrics',
  ]) {
    const box = (await page.locator(part).boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(focus.x);
    expect(box.x + box.width).toBeLessThanOrEqual(focus.x + focus.width);
    expect(box.y + box.height).toBeLessThanOrEqual(focus.y + focus.height);
  }
});

test('native BO formats, long bilingual names and missing portraits fit the same fixed rows', async ({
  page,
}) => {
  for (const variant of ['bo1', 'bo5', 'long-names', 'no-media']) {
    await page.goto(`/program?preview=1&variant=${variant}`);
    await expect(page.locator('.match-header__score-shell')).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    if (variant === 'bo1' || variant === 'bo5')
      await expect(page.locator('.match-header__series-map')).toHaveCount(
        variant === 'bo1' ? 1 : 5,
      );
    const names = await page.locator('.match-header__team-name').evaluateAll((nodes) =>
      nodes.map((n) => ({
        height: n.scrollHeight,
        available: n.parentElement!.clientHeight,
        size: parseFloat(getComputedStyle(n).fontSize),
      })),
    );
    expect(names.every((n) => n.height <= n.available && n.size >= 19)).toBe(true);
    if (variant === 'no-media') {
      await expect(page.locator('.player-rail__avatar img')).toHaveCount(0);
      expect((await page.locator('.player-rail__avatar').first().boundingBox())!.width).toBe(20);
    }
  }
});

test('Waiting treats real team logos as the primary identity, with aligned name baselines', async ({
  page,
}) => {
  const { payload } = sample('real-live-rich');
  const presentation = {
    schemaVersion: 'mizar.program-presentation.v1',
    packageId: 'builtin:mizar-default',
    match: payload.match,
    series: payload.series,
    halftime: null,
    completed: [],
    eventLogoUrl: null,
    scheduledAt: null as string | null,
    previous: null,
    next: null,
  };
  await page.route('**/local/v1/program-presentation', (route) =>
    route.fulfill({ json: presentation }),
  );
  await page.goto('/program/waiting');
  await expect(page.locator('.waiting-team img')).toHaveCount(2);
  await expect
    .poll(() =>
      page
        .locator('.waiting-team img')
        .evaluateAll((nodes) => nodes.every((n) => (n as HTMLImageElement).naturalWidth > 0)),
    )
    .toBe(true);
  const a = (await page.locator('.waiting-team--a img').boundingBox())!;
  const b = (await page.locator('.waiting-team--b img').boundingBox())!;
  expect(a.height).toBe(224);
  expect(b.height).toBe(224);
  expect(a.y).toBe(b.y);
  const names = await page
    .locator('.waiting-team strong')
    .evaluateAll((nodes) => nodes.map((n) => n.getBoundingClientRect().y));
  expect(names[0]).toBe(names[1]);

  // Combine existing long-name/media edges: artwork must not intersect rendered text lines.
  presentation.series!.entrants.a.name = '长名称战队 · North Star International';
  presentation.series!.entrants.b.name = '长名称战队 · Southern Cross International';
  presentation.scheduledAt = '2026-05-24T02:30:00Z';
  await page.reload();
  await page.evaluate(() => document.fonts.ready);
  const clear = await page.locator('.program-scene').evaluate((root) => {
    const labels = [...root.querySelectorAll('.waiting-team strong')].flatMap((el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      return [...range.getClientRects()];
    });
    const edge = root.querySelector<SVGPathElement>('.broadcast-arc__front')!;
    const matrix = edge.getScreenCTM()!;
    const length = edge.getTotalLength();
    for (let i = 0; i <= 512; i++) {
      const p = edge.getPointAtLength((length * i) / 512);
      const point = new DOMPoint(p.x, p.y).matrixTransform(matrix);
      if (
        labels.some(
          (box) =>
            point.x >= box.left &&
            point.x <= box.right &&
            point.y >= box.top &&
            point.y <= box.bottom,
        )
      )
        return false;
    }
    const time = root.querySelector('.waiting-time')!.getBoundingClientRect();
    return labels.every((box) => box.bottom < time.top);
  });
  expect(clear).toBe(true);
});

test('native smoke uses the shared cloud below combat information and clears at freeze', async ({
  page,
}) => {
  const preset = getBuiltinResolvedPreset();
  let snapshot = sample('real-live-rich');
  await page.route('**/local/v1/hud-config', (route) =>
    route.fulfill({ json: { resolved: preset, etag: 'smoke', activeRevision: 'smoke' } }),
  );
  await page.routeWebSocket('**/local/v1/program', (socket) =>
    socket.send(JSON.stringify(snapshot)),
  );
  await page.goto('/program?hud-config=companion');
  const affected = snapshot.payload.players.filter((player) => (player.state?.smoked ?? 0) > 0);
  expect(affected).toHaveLength(2);
  for (const player of affected) {
    const card = page.locator(`[data-player-card="${player.sourcePlayerId}"]`);
    await expect(card.locator(':scope > .broadcast-smoke')).toHaveAttribute('data-smoked', 'true');
    await expect(
      card.locator('.player-status-effects > .player-status-effects__smoke'),
    ).toHaveCount(0);
    const planes = await card.evaluate((el) => {
      const z = (selector: string) => Number(getComputedStyle(el.querySelector(selector)!).zIndex);
      return {
        smoke: z('.broadcast-smoke'),
        media: z('.player-rail__avatar'),
        info: [
          '.player-rail__identity',
          '.player-rail__health-bar',
          '.player-rail__weapons',
          '.player-rail__equipment',
          '.player-rail__utility-icons',
        ].map(z),
      };
    });
    expect(planes.smoke).toBeGreaterThan(planes.media);
    expect(planes.info.every((z) => z > planes.smoke)).toBe(true);
  }
  // Presentation-only observer switch; retain the captured player smoke values.
  snapshot.payload.observedPlayerSourceId = affected[0]!.sourcePlayerId;
  await page.reload();
  const focus = page.locator('.focused-player__face').last();
  await expect(focus.locator('.broadcast-smoke')).toHaveAttribute('data-smoked', 'true');
  const visible = await focus.evaluate((el) => {
    const plane = Number(getComputedStyle(el.querySelector('.broadcast-smoke')!).zIndex);
    return [
      '.focused-player__identity',
      '.focused-player__vitals',
      '.focused-player__active',
      '.focused-player__ammo',
    ].every((selector) => Number(getComputedStyle(el.querySelector(selector)!).zIndex) > plane);
  });
  expect(visible).toBe(true);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(focus.locator('.player-status-effects__smoke')).toHaveCSS('animation-name', 'none');
  snapshot = sample('real-post-explosion-freezetime');
  await page.reload();
  await expect(page.locator('.broadcast-smoke[data-smoked="true"]')).toHaveCount(0);
});

test('Pulse objective flash follows factual mode and reduced motion stops decorative animation', async ({
  page,
}) => {
  await page.route('**/local/v1/hud-config', (route) =>
    route.fulfill({
      json: { resolved: getBuiltinResolvedPreset(), etag: 'pulse', activeRevision: 'pulse' },
    }),
  );
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await feed(page, 'real-defusing');
  const shell = page.locator('.match-header__score-shell');
  await expect(shell).toHaveCSS('animation-name', 'mizar-pulse-defusing');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(shell).toHaveCSS('animation-name', 'none');
  await expect(page.locator('.objective-center')).toHaveAttribute(
    'data-objective-mode',
    'defusing',
  );
  const observed = page.locator('.player-rail__card[data-observed="true"]').first();
  await expect(observed).toHaveCSS('animation-name', 'none');
});

test('native radar envelope clears both economy and utility rows in live and freeze', async ({
  page,
}) => {
  await page.route('**/local/v1/hud-config', (route) =>
    route.fulfill({
      json: {
        resolved: getBuiltinResolvedPreset(),
        etag: 'pulse-position',
        activeRevision: 'pulse-position',
      },
    }),
  );
  for (const id of ['real-live-rich', 'real-post-explosion-freezetime']) {
    await feed(page, id);
    const radar = (await page.locator('[data-hud-widget="radar"]').boundingBox())!;
    const summary = (await page
      .locator('.player-rail--left .player-rail__summary-slot')
      .boundingBox())!;
    const strip = (await page.locator('[data-hud-widget="series-strip"]').boundingBox())!;
    expect(radar.width).toBe(radar.height);
    expect(radar.y).toBeGreaterThanOrEqual(strip.y + strip.height + 8);
    expect(radar.y + radar.height + 8).toBeLessThanOrEqual(summary.y);
  }
});
