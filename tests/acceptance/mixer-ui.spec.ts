import type { MixerCommand } from '../../packages/protocol/src/mixer.js';
import type { MusicConfig } from '../../packages/protocol/src/music.js';
import { test, expect } from './companion-isolation.js';

test('mixer uses confirmed state and music gains stay local to their scene entry', async ({
  page,
}) => {
  const channels = Object.fromEntries(
    ['game', 'remoteCommentary', 'microphone', 'music'].map((name) => [
      name,
      { name, volume: 0.8, muted: false, control: 'available' },
    ]),
  ) as Record<string, { name: string; volume: number; muted: boolean; control: string }>;
  const track = { id: `${'a'.repeat(64)}.wav`, name: '合成.wav', startMs: 0, endMs: null };
  const firstEntry = { ...track, entryId: '00000000-0000-4000-8000-000000000001' };
  const secondEntry = { ...track, entryId: '00000000-0000-4000-8000-000000000002' };
  const groups = Object.fromEntries(
    ['waiting', 'tactical', 'technical', 'halftime', 'mapVictory', 'matchVictory', 'opening'].map(
      (group) => [
        group,
        {
          enabled: true,
          tracks:
            group === 'waiting'
              ? [firstEntry, secondEntry]
              : group === 'technical'
                ? [firstEntry]
                : [],
          order: 'sequence',
          volume: 0.5,
          fadeInMs: 600,
          fadeOutMs: 600,
        },
      ],
    ),
  );
  let saved: MusicConfig | null = null;
  let played: { action: string; entryId?: string } | null = null;
  let next = 'confirmed';
  const writes: MixerCommand[] = [];
  await page.route('**/local/v1/mixer', (route) =>
    route.fulfill({ json: { revision: 'r1', channels } }),
  );
  await page.route('**/operator/mixer', (route) => {
    const body = route.request().postDataJSON() as MixerCommand;
    writes.push(body);
    const status = next;
    next = 'confirmed';
    if (status === 'confirmed') Object.assign(channels[body.channel]!, body);
    return route.fulfill({
      json: { status, ...(status === 'unknown' ? { message: '结果未确认，请核对 OBS。' } : {}) },
    });
  });
  await page.route('**/local/v1/music', (route) =>
    route.fulfill({
      json: {
        config: { version: 1, groups },
        storage: { ready: true, failed: false },
        status: {
          held: false,
          connection: 'connected',
          message: null,
          bgm: { group: 'waiting', track: '合成.wav', volume: 0.5, playbackId: 'p' },
          stinger: null,
          playback: 'playing',
          intent: 'manual',
          cursorMs: 1000,
          durationMs: 10000,
          segmentStartMs: 0,
          segmentEndMs: null,
          monitor: 'disabled',
        },
      },
    }),
  );
  await page.route('**/operator/music', (route) => {
    const body = route.request().postDataJSON() as { action: string; config: MusicConfig };
    if (body.action === 'configure') saved = body.config;
    if (body.action === 'play') played = body;
    return route.fulfill({ json: { ok: true } });
  });
  await page.goto('/settings?tab=music');
  await expect(page.getByRole('slider', { name: '游戏音量' })).toBeEnabled();
  await page.getByRole('button', { name: '静音游戏' }).click();
  await expect(page.getByRole('button', { name: '取消静音游戏' })).toBeVisible();
  expect(writes.at(-1)).toEqual({ revision: 'r1', channel: 'game', muted: true });
  next = 'unknown';
  await page.getByRole('button', { name: '静音其他解说' }).click();
  await expect(page.getByRole('alert')).toContainText('结果未确认');
  const slider = page.getByRole('slider', { name: '麦克风音量' });
  const box = (await slider.boundingBox())!;
  const before = writes.length;
  await page.mouse.move(box.x + box.width * 0.8, box.y + box.height / 2);
  await page.mouse.down();
  for (const x of [0.6, 0.2, 0.7, 0.4])
    await page.mouse.move(box.x + box.width * x, box.y + box.height / 2);
  await page.mouse.up();
  await expect.poll(() => writes.length).toBe(before + 1);
  expect(writes.at(-1)!.channel).toBe('microphone');
  await page.goto('/settings?tab=music');
  await page.getByLabel('正式播放曲目').selectOption(`waiting:${secondEntry.entryId}`);
  await page.getByRole('button', { name: '播放所选' }).click();
  await expect.poll(() => played).toMatchObject({ action: 'play', entryId: secondEntry.entryId });
  const waiting = page
    .getByRole('list', { name: '等待音乐曲目列表' })
    .getByRole('slider', { name: '合成.wav 音量' })
    .first();
  await waiting.focus();
  await page.keyboard.press('ArrowRight');
  await page.getByRole('button', { name: '音源', exact: true }).click();
  await page
    .getByRole('navigation', { name: '声音设置分区' })
    .getByRole('button', { name: '音乐', exact: true })
    .click();
  await expect(waiting).toHaveValue('0.55');
  await page
    .getByRole('navigation', { name: '音乐场景' })
    .getByRole('button', { name: /技术暂停/ })
    .click();
  await expect(
    page
      .getByRole('list', { name: '技术暂停曲目列表' })
      .getByRole('slider', { name: '合成.wav 音量' }),
  ).toHaveValue('0.5');
  await page
    .getByRole('navigation', { name: '音乐场景' })
    .getByRole('button', { name: /等待音乐/ })
    .click();
  await expect(waiting).toHaveValue('0.55');
  await page.getByRole('button', { name: '保存音乐配置', exact: true }).click();
  await expect.poll(() => saved).not.toBeNull();
  expect(saved!.groups.waiting.tracks[0]).toMatchObject({
    entryId: firstEntry.entryId,
    gain: 0.55,
  });
  expect(saved!.groups.waiting.tracks[1]).toMatchObject({ entryId: secondEntry.entryId });
  expect(saved!.groups.waiting.tracks[1]!.gain).toBeUndefined();
  expect(saved!.groups.technical.tracks[0]!.gain).toBeUndefined();
  saved = null;
  await page
    .getByRole('list', { name: '等待音乐曲目列表' })
    .getByRole('button', { name: '移除 合成.wav' })
    .first()
    .click();
  await page.getByRole('button', { name: '保存音乐配置', exact: true }).click();
  await expect.poll(() => saved).not.toBeNull();
  expect(saved!.groups.waiting.tracks).toEqual([secondEntry]);
});
