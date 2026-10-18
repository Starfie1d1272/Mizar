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
const REPLAY_SEEK_TIMEOUT = 30_000;

function parseJsonLines<T>(content: string): T[] {
  return content
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

async function selectReplayEvent(
  page: Page,
  sequenceRegion: Locator,
  event: ReplayEventFixture,
): Promise<void> {
  await page.getByText('回放事件与序列', { exact: true }).click();
  await page.getByLabel('语义事件', { exact: true }).selectOption(event.id);
  await expect(sequenceRegion).toHaveAttribute('data-replay-cursor', String(event.sequence), {
    timeout: REPLAY_SEEK_TIMEOUT,
  });
}

test.describe('HUD 编辑器 Replay acceptance', () => {
  test('selects EPL and rebuilds its selected real C4 event with matching identities', async ({
    page,
  }) => {
    await page.goto('/operator/hud?mode=fixture');
    await page.getByLabel('预览来源').selectOption('replay');
    await page.getByLabel('回放来源', { exact: true }).selectOption('epl-inferno-opening');
    const replay = page.getByRole('region', { name: '重放控制' });
    await expect(replay).toHaveAttribute('data-replay-cursor', '13');
    await expect(page.locator('body')).toContainText('Falcons');
    await expect(page.locator('body')).toContainText('Natus Vincere');
    await expect(page.locator('[data-avatar-present="true"]')).toHaveCount(10);
    const avatar = await page.request.get('/fixture-media/epl-s24/76561198074762801.jpg');
    expect(avatar.ok()).toBe(true);
    expect(avatar.headers()['content-type']).toContain('image/jpeg');
    await page.getByLabel('回放来源', { exact: true }).selectOption('epl-inferno-final-round');
    await expect(replay).toHaveAttribute('data-replay-cursor', '2200');
    const response = await page.request.get(
      '/fixtures/epl-inferno-final-round/replay/events.jsonl',
    );
    const events = parseJsonLines<ReplayEventFixture>(await response.text());
    const planted = events.find(
      (event) => event.kind === 'bomb-state' && event.detail.to === 'planted',
    );
    expect(planted).toBeDefined();
    const rebuiltResponse = await page.request.post('/__local/replay-prefix', {
      data: { sourceId: 'epl-inferno-final-round', targetSequence: planted!.sequence },
    });
    expect(rebuiltResponse.ok()).toBe(true);
    const framesResponse = await page.request.get(
      '/fixtures/epl-inferno-final-round/replay/frames.jsonl',
    );
    const recorded = parseJsonLines<ReplayFrameFixture & { program: unknown; radar: unknown }>(
      await framesResponse.text(),
    ).find((frame) => frame.cursor.sequence === planted!.sequence)!;
    expect(await rebuiltResponse.json()).toEqual({
      targetSequence: planted!.sequence,
      program: recorded.program,
      radar: recorded.radar,
    });
    await selectReplayEvent(page, replay, planted!);
    await expect(page.locator('body')).toContainText('m0NESY');
    await expect(page.locator('[data-hud-widget="radar"] canvas.radar')).toHaveAttribute(
      'data-radar-state',
      'live',
    );
  });
});
