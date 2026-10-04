import type { Locator, Page } from '@playwright/test';
import { expect, test } from './companion-isolation.js';

interface ReplayEventFixture {
  readonly id: string;
  readonly kind: string;
  readonly sequence: number;
  readonly scheduledElapsedUs: number;
  readonly label: string;
  readonly detail: Readonly<Record<string, unknown>>;
}

interface ReplayFrameFixture {
  readonly cursor: {
    readonly captureIndex: number;
    readonly sequence: number;
    readonly scheduledElapsedUs: number;
  };
}

const REPLAY_CLOCK_START = '2026-01-01T00:00:00.000Z';
const REPLAY_SEEK_TIMEOUT = 30_000;

async function installReplayClock(page: Page): Promise<void> {
  await page.clock.install({ time: new Date(REPLAY_CLOCK_START) });
}

async function pauseReplayClock(page: Page): Promise<void> {
  const pauseAt = await page.evaluate(() => Date.now() + 5_000);
  await page.clock.pauseAt(pauseAt);
}

function parseJsonLines<T>(content: string): T[] {
  return content
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

function frameAt(frames: readonly ReplayFrameFixture[], sequence: number): ReplayFrameFixture {
  const frame = frames.find((candidate) => candidate.cursor.sequence === sequence);
  if (frame === undefined) throw new Error(`Ancient replay has no sequence ${sequence}`);
  return frame;
}

function eventAt(
  events: readonly ReplayEventFixture[],
  kind: string,
  sequence: number,
  matches: (event: ReplayEventFixture) => boolean = () => true,
): ReplayEventFixture {
  const event = events.find(
    (candidate) => candidate.kind === kind && candidate.sequence === sequence && matches(candidate),
  );
  if (event === undefined) throw new Error(`Ancient replay has no ${kind} anchor at ${sequence}`);
  return event;
}

async function loadAncientReplay(page: Page) {
  const [eventsResponse, framesResponse] = await Promise.all([
    page.request.get('/fixtures/ancient-round-03/replay/events.jsonl'),
    page.request.get('/fixtures/ancient-round-03/replay/frames.jsonl'),
  ]);
  expect(eventsResponse.ok()).toBe(true);
  expect(framesResponse.ok()).toBe(true);
  return {
    events: parseJsonLines<ReplayEventFixture>(await eventsResponse.text()),
    frames: parseJsonLines<ReplayFrameFixture>(await framesResponse.text()),
  };
}

async function selectReplayEvent(
  page: Page,
  sequenceRegion: Locator,
  event: ReplayEventFixture,
): Promise<void> {
  await page.getByLabel('语义事件', { exact: true }).selectOption(event.id);
  await expect(sequenceRegion).toHaveAttribute('data-replay-cursor', String(event.sequence), {
    timeout: REPLAY_SEEK_TIMEOUT,
  });
}

async function advanceReplayTo(
  page: Page,
  sequenceRegion: Locator,
  frames: readonly ReplayFrameFixture[],
  targetSequence: number,
): Promise<void> {
  const currentSequence = Number(await sequenceRegion.getAttribute('data-replay-cursor'));
  const currentFrame = frameAt(frames, currentSequence);
  const targetFrame = frameAt(frames, targetSequence);
  if (targetFrame.cursor.captureIndex < currentFrame.cursor.captureIndex) {
    throw new Error(`Cannot play backwards from ${currentSequence}`);
  }
  const path = frames.filter(
    (frame) =>
      frame.cursor.captureIndex > currentFrame.cursor.captureIndex &&
      frame.cursor.captureIndex <= targetFrame.cursor.captureIndex,
  );
  await page.getByRole('button', { name: '播放' }).click();
  let previousElapsedUs = currentFrame.cursor.scheduledElapsedUs;
  for (const frame of path) {
    const elapsedUs = frame.cursor.scheduledElapsedUs;
    await page.clock.runFor((elapsedUs - previousElapsedUs) / 1_000 + 2);
    await expect(sequenceRegion).toHaveAttribute(
      'data-replay-cursor',
      String(frame.cursor.sequence),
    );
    previousElapsedUs = elapsedUs;
  }
  await expect(sequenceRegion).toHaveAttribute('data-replay-cursor', String(targetSequence));
  await page.getByRole('button', { name: '暂停' }).click();
  await page.clock.runFor(20);
}

async function seekReplayTo(
  page: Page,
  sequenceRegion: Locator,
  frames: readonly ReplayFrameFixture[],
  targetSequence: number,
): Promise<void> {
  const targetFrame = frameAt(frames, targetSequence);
  await page.getByLabel('回放进度').evaluate((element, captureIndex) => {
    if (!(element instanceof HTMLInputElement)) throw new Error('Replay scrubber is unavailable');
    const valueDescriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    const setValue =
      valueDescriptor === undefined
        ? undefined
        : (Reflect.get(valueDescriptor, 'set') as
            ((this: HTMLInputElement, value: string) => void) | undefined);
    if (setValue === undefined) throw new Error('Replay scrubber cannot be updated');
    Reflect.apply(setValue, element, [String(captureIndex)]);
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
  }, targetFrame.cursor.captureIndex);
  await expect(sequenceRegion).toHaveAttribute('data-replay-cursor', String(targetSequence), {
    timeout: REPLAY_SEEK_TIMEOUT,
  });
}

async function readPlayerRailState(rail: Locator) {
  return rail.evaluate((element) => ({
    entrant: element.getAttribute('data-entrant'),
    phase: element.getAttribute('data-player-rail-phase'),
    side: element.getAttribute('data-player-rail'),
    players: Array.from(element.querySelectorAll<HTMLElement>('[data-player-card]')).map(
      (player) => ({
        id: player.dataset.playerCard,
        lifeState: player.dataset.lifeState,
        observed: player.dataset.observed,
        side: player.dataset.side,
        text: player.innerText.replace(/\s+/g, ' ').trim(),
      }),
    ),
  }));
}

test.describe('HUD 编辑器 Replay acceptance', () => {
  test.describe.configure({ timeout: 90_000 });

  test('shows the fixed real identities and locally frozen presentation assets', async ({
    page,
  }) => {
    await page.clock.install();
    await page.goto('/operator/hud');
    await page.getByLabel('预览来源').selectOption('replay');

    const replay = page.getByRole('region', { name: '重放控制' });
    await expect(replay).toHaveAttribute('data-replay-cursor', '587');
    await expect(page.locator('body')).toContainText('FURIA');
    await expect(page.locator('body')).toContainText('G2.Esports');
    for (const displayName of ['FalleN', 'huNter-', 'KSCERATO', 'YEKINDAR']) {
      await expect(page.locator('body')).toContainText(displayName);
    }
    await expect(page.locator('[data-avatar-present="true"]')).toHaveCount(10);
    await expect(page.locator('img[src*="team-furia.svg"]')).not.toHaveCount(0);
    await expect(page.locator('img[src*="team-g2.png"]')).not.toHaveCount(0);
    await expect(page.locator('[data-hud-widget="radar"] canvas.radar')).toHaveAttribute(
      'data-radar-state',
      'live',
    );
  });

  test('uses capture time for smoke windows and renders a seek anchor deterministically', async ({
    page,
  }) => {
    await installReplayClock(page);
    await page.goto('/operator/hud');
    await pauseReplayClock(page);
    await page.getByLabel('预览来源').selectOption('replay');
    const replay = page.getByRole('region', { name: '重放控制' });
    await expect(replay).toHaveAttribute('data-replay-cursor', '587');

    const eventsResponse = await page.request.get('/fixtures/ancient-round-03/replay/events.jsonl');
    expect(eventsResponse.ok()).toBe(true);
    const events = (await eventsResponse.text())
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as ReplayEventFixture);
    const seekAnchor = events.find((event) => event.kind === 'bomb-state');
    const smokeStart = eventAt(events, 'smoke-start', 669);
    expect(seekAnchor).toBeDefined();
    expect(smokeStart).toBeDefined();
    const smokeEnd = eventAt(events, 'smoke-end', 771, (event) =>
      Object.is(event.detail.sourceEntityId, smokeStart.detail.sourceEntityId),
    );
    expect(smokeEnd).toBeDefined();

    const radar = page.locator('[data-hud-widget="radar"] canvas.radar');
    await page.clock.runFor(32);
    await expect(radar).toHaveAttribute('data-radar-smokes', '0');

    const eventSelect = page.getByLabel('语义事件', { exact: true });
    await eventSelect.selectOption(seekAnchor!.id);
    await expect(replay).toHaveAttribute('data-replay-cursor', String(seekAnchor!.sequence));
    await page.clock.runFor(300);
    const teamCtRail = page.locator('[data-hud-widget="team-ct-rail"]');
    const directSeekState = await readPlayerRailState(teamCtRail);

    await page.getByRole('button', { name: '重播' }).click();
    await expect(replay).toHaveAttribute('data-replay-cursor', '587');
    await page.getByRole('button', { name: '播放' }).click();
    await page.clock.runFor(seekAnchor!.scheduledElapsedUs / 1_000 + 2);
    await expect(replay).toHaveAttribute('data-replay-cursor', String(seekAnchor!.sequence));
    await page.getByRole('button', { name: '暂停' }).click();
    await page.clock.runFor(300);
    expect(await readPlayerRailState(teamCtRail)).toEqual(directSeekState);

    await eventSelect.selectOption(smokeStart.id);
    await expect(replay).toHaveAttribute('data-replay-cursor', String(smokeStart.sequence));
    await page.clock.runFor(32);
    await expect(radar).toHaveAttribute('data-radar-smokes', '0');
    const { frames } = await loadAncientReplay(page);
    await advanceReplayTo(page, replay, frames, 691);
    await expect(radar).toHaveAttribute('data-radar-sample-sequence', '691');
    await expect(radar).not.toHaveAttribute('data-radar-smokes', '0');
    await eventSelect.selectOption(smokeEnd.id);
    await expect(replay).toHaveAttribute('data-replay-cursor', String(smokeEnd.sequence));
    await page.clock.runFor(32);
    await expect(radar).toHaveAttribute('data-radar-sample-sequence', '771');
    await expect(radar).not.toHaveAttribute(
      'data-radar-utility-phases',
      /188:(?:projectile|effect)/,
    );
  });

  test('animates real airborne utility, item switches, and smoke to inferno handoff', async ({
    page,
  }, testInfo) => {
    await installReplayClock(page);
    await page.goto('/operator/hud');
    await pauseReplayClock(page);
    await page.getByLabel('预览来源').selectOption('replay');
    const replay = page.getByRole('region', { name: '重放控制' });
    const radar = page.locator('[data-hud-widget="radar"] canvas.radar');
    const { events, frames } = await loadAncientReplay(page);

    const airborneSmoke = eventAt(
      events,
      'grenade-airborne',
      669,
      (event) => event.detail.kind === 'smoke',
    );
    const adjacentSmoke = eventAt(
      events,
      'grenade-airborne',
      670,
      (event) => event.detail.kind === 'smoke',
    );
    await selectReplayEvent(page, replay, airborneSmoke);
    await page.clock.runFor(32);
    await expect(radar).toHaveAttribute('data-radar-utility-phases', /188:projectile/);
    await expect(radar).toHaveAttribute('data-radar-projectile-ids', /188/);

    const playerCard = page.locator('.focused-player');
    await expect(playerCard).toHaveAttribute('data-focused-player', '76561198058500492');
    const activeItem = playerCard.locator('.focused-player__active');
    await expect(activeItem).toHaveAttribute('data-active-item-kind', 'knife');

    await selectReplayEvent(page, replay, adjacentSmoke);
    await page.clock.runFor(32);
    await expect(activeItem).toHaveAttribute('data-active-item-kind', 'grenade');
    await expect(activeItem).toHaveAttribute('data-item-transition', 'false');
    await expect(radar).toHaveAttribute('data-radar-trails', '2');
    const snappedMotion = (await radar.getAttribute('data-radar-observed-motion'))
      ?.split(',')
      .map(Number);
    expect(snappedMotion).toHaveLength(6);
    expect(snappedMotion![0]).toBe(snappedMotion![2]);
    expect(snappedMotion![1]).toBe(snappedMotion![3]);
    expect(snappedMotion![4]).toBe(snappedMotion![2]);
    expect(snappedMotion![5]).toBe(snappedMotion![3]);

    await selectReplayEvent(page, replay, airborneSmoke);
    await page.clock.runFor(32);

    await advanceReplayTo(page, replay, frames, 670);
    await expect(activeItem).toHaveAttribute('data-active-item-kind', 'grenade');
    await expect(activeItem).toHaveAttribute('data-item-transition', 'true');
    await expect(radar).toHaveAttribute('data-radar-utility-phases', /188:projectile/);
    await expect(radar).toHaveAttribute('data-radar-trails', /[2-9]|[1-9][0-9]/);
    await page.clock.runFor(32);
    await testInfo.attach('ancient-r03-airborne-utility-seq-670', {
      body: await radar.screenshot({ animations: 'disabled' }),
      contentType: 'image/png',
    });

    const motion = (await radar.getAttribute('data-radar-observed-motion'))?.split(',').map(Number);
    expect(motion).toHaveLength(6);
    const [fromX, fromY, toX, toY, currentX, currentY] = motion!;
    const dx = toX! - fromX!;
    const dy = toY! - fromY!;
    const lengthSquared = dx * dx + dy * dy;
    expect(lengthSquared).toBeGreaterThan(0);
    const progress = ((currentX! - fromX!) * dx + (currentY! - fromY!) * dy) / lengthSquared;
    expect(progress).toBeGreaterThan(0);
    expect(progress).toBeLessThan(1);
    expect(await radar.getAttribute('data-radar-observed-player')).toBe('76561198058500492');
    await page.clock.runFor(100);
    await expect(activeItem).toHaveAttribute('data-item-transition', 'false');

    await advanceReplayTo(page, replay, frames, 691);
    await expect(radar).toHaveAttribute('data-radar-sample-sequence', '691');
    await expect(radar).toHaveAttribute('data-radar-utility-phases', /188:effect/);
    await expect(radar).toHaveAttribute('data-radar-utility-phases', /299:projectile/);
    await expect(radar).toHaveAttribute('data-radar-projectile-ids', /299/);
    await testInfo.attach('ancient-r03-smoke-effect-firebomb-flight-seq-691', {
      body: await radar.screenshot({ animations: 'disabled' }),
      contentType: 'image/png',
    });

    await advanceReplayTo(page, replay, frames, 699);
    await expect(radar).toHaveAttribute('data-radar-utility-phases', /210:effect/);
    await expect(radar).not.toHaveAttribute('data-radar-utility-phases', /299:projectile/);
    await expect(radar).not.toHaveAttribute('data-radar-projectile-ids', /299/);
    await testInfo.attach('ancient-r03-inferno-handoff-seq-699', {
      body: await radar.screenshot({ animations: 'disabled' }),
      contentType: 'image/png',
    });
  });

  test('replay advances planting and C4 fuse progress through semantic states', async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await installReplayClock(page);
    await page.goto('/operator/hud');
    await pauseReplayClock(page);
    await page.getByLabel('预览来源').selectOption('replay');
    const replay = page.getByRole('region', { name: '重放控制' });
    const { events, frames } = await loadAncientReplay(page);
    const planting = eventAt(events, 'bomb-state', 1016, (event) => event.detail.to === 'planting');
    const planted = eventAt(events, 'bomb-state', 1029, (event) => event.detail.to === 'planted');
    await selectReplayEvent(page, replay, planting);

    const plantProgress = page.locator('.objective-center__plant-progress span');
    const early = Number(await plantProgress.getAttribute('data-action-value'));
    await advanceReplayTo(page, replay, frames, 1017);
    await expect(plantProgress).toHaveAttribute('data-action-transition', 'true');
    await advanceReplayTo(page, replay, frames, 1020);
    const middle = Number(await plantProgress.getAttribute('data-action-value'));
    await advanceReplayTo(page, replay, frames, 1025);
    const late = Number(await plantProgress.getAttribute('data-action-value'));
    expect(early).toBeLessThanOrEqual(middle);
    expect(middle).toBeLessThan(late);

    await advanceReplayTo(page, replay, frames, 1028);
    await advanceReplayTo(page, replay, frames, planted.sequence);
    const objective = page.locator('.objective-center');
    await expect(objective).toHaveAttribute('data-planted-transition', 'true');
    await page.clock.runFor(300);
    await expect(objective).toHaveAttribute('data-planted-transition', 'false');

    const fuse = page.locator('[data-objective-track="fuse"] span');
    await expect(fuse).toHaveCount(1);
    const full = Number(await fuse.getAttribute('data-fuse-value'));
    expect(full).toBeGreaterThan(0.95);
    await seekReplayTo(page, replay, frames, 1110);
    await page.clock.runFor(240);
    const half = Number(await fuse.getAttribute('data-fuse-value'));
    expect(half).toBeGreaterThan(0.45);
    expect(half).toBeLessThan(0.55);
    expect(full).toBeGreaterThan(half);
    await seekReplayTo(page, replay, frames, 1150);
    await page.clock.runFor(240);
    const quarter = Number(await fuse.getAttribute('data-fuse-value'));
    expect(quarter).toBeGreaterThan(0.2);
    expect(quarter).toBeLessThan(0.3);
    expect(half).toBeGreaterThan(quarter);
  });

  test('crossfades the real observer target inside a stable Focused Player card', async ({
    page,
  }, testInfo) => {
    await installReplayClock(page);
    let signalAvatarRequest!: () => void;
    const avatarRequested = new Promise<void>((resolve) => {
      signalAvatarRequest = resolve;
    });
    const releaseAvatarRequests: Array<() => void> = [];
    let holdIncomingAvatar = true;
    const releaseIncomingAvatar = () => {
      holdIncomingAvatar = false;
      for (const release of releaseAvatarRequests.splice(0)) release();
    };
    await page.route('**/avatar-76561198012872053-89e7f0ad4292.jpg', async (route) => {
      if (holdIncomingAvatar) {
        signalAvatarRequest();
        await new Promise<void>((resolve) => releaseAvatarRequests.push(resolve));
      }
      await route.continue();
    });
    await page.goto('/operator/hud', { waitUntil: 'domcontentloaded' });
    await pauseReplayClock(page);
    await page.getByLabel('预览来源').selectOption('replay');
    const replay = page.getByRole('region', { name: '重放控制' });
    const { events, frames } = await loadAncientReplay(page);
    const planted = eventAt(events, 'bomb-state', 1029, (event) => event.detail.to === 'planted');
    const switchEvent = eventAt(events, 'observer-target-switch', 1040);
    await selectReplayEvent(page, replay, planted);
    await advanceReplayTo(page, replay, frames, 1039);

    const card = page.locator('.focused-player');
    await expect(card).toHaveAttribute('data-focused-player', '76561198058500492');
    await card.evaluate((element) => element.setAttribute('data-acceptance-root-id', 'stable'));
    await advanceReplayTo(page, replay, frames, switchEvent.sequence);
    await expect(card).toHaveAttribute('data-focused-player', '76561198012872053');
    await expect(card).toHaveAttribute('data-acceptance-root-id', 'stable');
    await avatarRequested;
    await expect(card).toHaveAttribute('data-observer-transition', 'false');
    await expect(card.locator('.focused-player__face--pending')).toHaveCount(1);
    const outgoingWhileLoading = card.locator(
      '.focused-player__face:not(.focused-player__face--pending)',
    );
    await expect(outgoingWhileLoading.locator('.focused-player__name')).toContainText('KSCERATO');
    await expect(outgoingWhileLoading).toBeVisible();
    releaseIncomingAvatar();
    await expect(card).toHaveAttribute('data-observer-transition', 'true');
    const currentFace = card.locator('.focused-player__face:not(.focused-player__face--outgoing)');
    await expect(currentFace.locator('.focused-player__name')).toContainText('huNter-');
    const avatar = currentFace.locator('.focused-player__media');
    await expect(avatar).toHaveClass(/has-avatar/);
    const imageLoaded = await currentFace.locator('img').evaluate((image) => {
      const avatarImage = image as HTMLImageElement;
      return avatarImage.complete && avatarImage.naturalWidth > 0;
    });
    expect(imageLoaded).toBe(true);
    await testInfo.attach('ancient-r03-observer-switch-seq-1040', {
      body: await card.screenshot({ animations: 'disabled' }),
      contentType: 'image/png',
    });
    await page.clock.runFor(150);
    await expect(card).toHaveAttribute('data-observer-transition', 'false');
  });
});

test('Shanghai planting panel exits without a placeholder and planted C4 has reduced-motion-safe feedback', async ({
  page,
}) => {
  await installReplayClock(page);
  await page.goto('/operator/hud');
  await pauseReplayClock(page);
  await page
    .getByRole('combobox', { name: '预设', exact: true })
    .selectOption('builtin:perfectworld-preset');
  await page.getByLabel('预览来源').selectOption('replay');
  const replay = page.getByRole('region', { name: '重放控制' });
  const { events, frames } = await loadAncientReplay(page);
  await selectReplayEvent(
    page,
    replay,
    eventAt(events, 'bomb-state', 1016, (event) => event.detail.to === 'planting'),
  );
  await expect(page.locator('.shanghai-event-panel[data-kind="plant"]')).toBeVisible();
  await advanceReplayTo(page, replay, frames, 1028);
  await advanceReplayTo(page, replay, frames, 1029);
  await expect(page.locator('.shanghai-event-panel[data-kind="plant"]')).toHaveCount(0);
  const c4 = page.locator('.objective-center .shanghai-c4');
  await expect(c4).toBeVisible();
  await expect(c4).toHaveAttribute('data-asset-id', 'objective.c4');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await expect(c4).toHaveCSS('animation-name', 'shanghai-c4-pulse');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(c4).toHaveCSS('animation-name', 'none');
});

test('IEM metrics opt-in is visible and contained in the existing focus envelope', async ({
  page,
}) => {
  await page.goto('/operator/hud');
  await page
    .getByRole('combobox', { name: '预设', exact: true })
    .selectOption('builtin:iem-preset');
  await page
    .getByRole('combobox', { name: '配置组件', exact: true })
    .selectOption('focused-player');
  const toggle = page.getByRole('checkbox', { name: '显示 K/A/D/ADR', exact: true });
  await expect(toggle).not.toBeChecked();
  await toggle.check();
  const metrics = page.locator('.focused-player__metrics');
  await expect(metrics).toBeVisible();
  const footer = (await metrics.boundingBox())!;
  const card = (await page.locator('.focused-player').boundingBox())!;
  expect(footer.y).toBeGreaterThanOrEqual(card.y);
  expect(footer.y + footer.height).toBeLessThanOrEqual(card.y + card.height);
  await toggle.uncheck();
  await expect(metrics).toHaveCount(0);
});
