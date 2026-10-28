import { test, expect } from './companion-isolation.js';

test('workspace keeps its original compact music controls and has no BP strip', async ({
  page,
}) => {
  let held = false;
  let groupVolume = 0.65;
  const requests: { action: string; group?: string; volume?: number }[] = [];
  await page.route('**/local/v1/music', (route) =>
    route.fulfill({
      json: {
        config: { groups: { waiting: { volume: groupVolume } } },
        status: {
          held,
          intent: 'automatic',
          connection: 'connected',
          message: null,
          bgm: { group: 'waiting', track: '合成曲目.wav', volume: 0.2, playbackId: 'mock' },
          stinger: null,
          playback: 'playing',
          cursorMs: 0,
          durationMs: 1000,
          segmentStartMs: 0,
          segmentEndMs: null,
          monitor: 'disabled',
        },
      },
    }),
  );
  await page.route('**/operator/music', (route) => {
    const body = route.request().postDataJSON() as {
      action: string;
      group?: string;
      volume?: number;
    };
    requests.push(body);
    if (body.action === 'volume') groupVolume = body.volume!;
    if (body.action === 'stop') held = true;
    if (body.action === 'resume') held = false;
    return route.fulfill({ json: { ok: true } });
  });
  await page.goto('/workspace');
  await expect(page.getByText('紧凑 BP 底栏', { exact: true })).toHaveCount(0);
  const music = page.getByLabel('现场音乐', { exact: true });
  const volume = music.getByRole('slider', { name: '音乐音量' });
  await expect(volume).toHaveValue('0.65');
  await expect(music.getByRole('button', { name: '静音音乐' })).toHaveCount(0);
  await expect(music.getByRole('button', { name: '恢复自动音乐' })).toHaveCount(0);
  await volume.fill('0.75');
  await expect
    .poll(() => requests.at(-1))
    .toEqual({ action: 'volume', group: 'waiting', volume: 0.75 });
  await music.getByRole('button', { name: '停止音乐' }).click();
  await expect(music.getByRole('button', { name: '恢复自动音乐' })).toBeVisible({ timeout: 5000 });
  await music.getByRole('button', { name: '恢复自动音乐' }).click();
  await expect.poll(() => requests.at(-1)?.action).toBe('resume');
});
