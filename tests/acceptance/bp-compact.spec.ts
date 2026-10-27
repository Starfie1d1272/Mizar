import { expect, test } from '@playwright/test';

const names = ['ancient', 'anubis', 'inferno', 'nuke', 'mirage', 'dust2', 'vertigo'];
const kinds = ['ban', 'ban', 'pick', 'pick', 'ban', 'ban', 'decider'];
const cards = names.map((name, index) => ({
  mapName: `de_${name}`,
  kind: kinds[index],
  entrant: index === 6 ? null : index % 2 ? 'b' : 'a',
  sideChoice: index === 2 ? { entrant: 'b', side: 'CT' } : null,
}));
const steps = cards.flatMap((card, index) => [
  { cardIndex: index, kind: 'card' },
  ...(card.sideChoice ? [{ cardIndex: index, kind: 'side-choice' }] : []),
]);

test('compact source follows the BP reveal cursor and clears when disconnected', async ({
  page,
}) => {
  let count = 1;
  let online = true;
  await page.route('**/local/v1/bp', (route) => {
    if (!online) return route.abort();
    return route.fulfill({
      json: {
        schemaVersion: 'mizar.bp.v2',
        revision: 'fixture',
        state: 'revealing',
        revealedCount: count,
        projection: {
          competition: 'Fixture',
          stage: 'Fixture',
          format: 'bo3',
          entrants: {
            a: { name: '甲'.repeat(60), logoUrl: null },
            b: { name: '乙'.repeat(60), logoUrl: null },
          },
          cards,
          steps,
        },
      },
    });
  });
  await page.route('**/local/v1/program-scenes', (route) =>
    route.fulfill({
      json: {
        schemaVersion: 'mizar.program-scenes.v1',
        active: 'gameplay',
        revision: 'fixture',
        bpCompact: 'on',
        available: [],
        blocked: {},
      },
    }),
  );
  await page.goto('/program/bp-compact');
  const strip = page.locator('.bp-compact');
  await expect(strip).toContainText('ANCIENT');
  await expect(strip).not.toContainText('INFERNO');
  await expect(strip.locator('.bp-compact-card[data-kind="pending"] img')).toHaveCount(0);
  for (const pending of await strip.locator('.bp-compact-card[data-kind="pending"]').all()) {
    await expect(pending).toHaveText('待揭示');
    await expect(pending).not.toHaveAttribute('data-entrant');
  }
  count = 3;
  await expect(strip).toContainText('INFERNO');
  await expect(strip).not.toContainText('CT');
  count = 4;
  await expect(strip).toContainText('CT');
  online = false;
  await expect(strip).toHaveCount(0);
});

test('BO1 and BO5 fixtures keep long names and cards within the compact strip', async ({
  page,
}) => {
  let format: 'bo1' | 'bo5' = 'bo1';
  await page.route('**/local/v1/bp', (route) => {
    const formatKinds =
      format === 'bo1'
        ? ['ban', 'ban', 'ban', 'ban', 'ban', 'ban', 'decider']
        : ['ban', 'ban', 'pick', 'pick', 'pick', 'pick', 'decider'];
    const formatCards = names.map((name, index) => ({
      mapName: `de_${name}`,
      kind: formatKinds[index],
      entrant: index === 6 ? null : index % 2 ? 'b' : 'a',
      sideChoice: null,
    }));
    return route.fulfill({
      json: {
        schemaVersion: 'mizar.bp.v2',
        revision: format,
        state: 'shown',
        revealedCount: 7,
        projection: {
          competition: 'Fixture',
          stage: 'Fixture',
          format,
          entrants: {
            a: { name: '非常长的中文战队名称'.repeat(8), logoUrl: null },
            b: { name: '另一支非常长的中文战队名称'.repeat(8), logoUrl: null },
          },
          cards: formatCards,
          steps: formatCards.map((_, index) => ({ cardIndex: index, kind: 'card' })),
        },
      },
    });
  });
  await page.route('**/local/v1/program-scenes', (route) =>
    route.fulfill({
      json: {
        schemaVersion: 'mizar.program-scenes.v1',
        active: 'gameplay',
        revision: 'fixture',
        bpCompact: 'on',
        available: [],
        blocked: {},
      },
    }),
  );
  await page.goto('/program/bp-compact');
  await expect(page.locator('.bp-compact-status > span').last()).toContainText('BO1');
  await expect(page.locator('.bp-logo-fallback')).toHaveCount(6);
  format = 'bo5';
  await expect(page.locator('.bp-compact-status > span').last()).toContainText('BO5');
  await expect(page.locator('.bp-compact-card')).toHaveCount(7);
  const fits = await page.locator('.bp-compact').evaluate((strip) => {
    const bounds = strip.getBoundingClientRect();
    return [...strip.querySelectorAll('.bp-compact-card')].every((item) => {
      const rect = item.getBoundingClientRect();
      return (
        rect.left >= bounds.left &&
        rect.right <= bounds.right &&
        rect.top >= bounds.top &&
        rect.bottom <= bounds.bottom
      );
    });
  });
  expect(fits).toBe(true);
  // OBS scales the fixed 1920×1080 browser source to the output canvas.
  for (const [width, height] of [
    [2560, 1440],
    [3840, 2160],
  ]) {
    await page.setViewportSize({ width: width!, height: height! });
    await page.locator('#root').evaluate((root, scale) => {
      (root as HTMLElement).style.transformOrigin = 'top left';
      (root as HTMLElement).style.transform = `scale(${scale})`;
    }, width! / 1920);
    const bounds = (await page.locator('.bp-compact').boundingBox())!;
    expect(bounds.x).toBeCloseTo((48 * width!) / 1920, 0);
    expect(bounds.y + bounds.height).toBeCloseTo(height! - (32 * width!) / 1920, 0);
    expect(bounds.width).toBeCloseTo((1824 * width!) / 1920, 0);
  }
});
