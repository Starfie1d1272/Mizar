import { test, expect } from './companion-isolation.js';

for (const mode of ['standard', 'mulnx', 'connected', 'borrowed'] as const) {
  test(`workspace dock stays compact with ${mode} game`, async ({ page, context }) => {
    const calls: { command: string; args?: Record<string, unknown> }[] = [];
    await context.exposeBinding(
      'workspaceNative',
      (_source, command: string, args?: Record<string, unknown>) => {
        calls.push({ command, ...(args ? { args } : {}) });
        if (command === 'cs2_config_status')
          return {
            preferMulnx: mode === 'mulnx',
            borrowed: mode === 'borrowed',
            running: true,
            pending: false,
            busy: false,
            message: null,
          };
        if (command === 'workspace_exit_status') return { busy: false, stage: '', message: null };
        return null;
      },
    );
    await context.addInitScript(() =>
      Object.assign(window, {
        __TAURI_INTERNALS__: {
          invoke: (command: string, args?: Record<string, unknown>) =>
            (
              window as typeof window & {
                workspaceNative: (
                  command: string,
                  args?: Record<string, unknown>,
                ) => Promise<unknown>;
              }
            ).workspaceNative(command, args),
        },
      }),
    );
    await page.route('**/local/v1/orchestration', (route) =>
      route.fulfill({
        json: {
          preset: { maps: [] },
          status: {
            connected: mode === 'connected',
            held: true,
            control: { state: 'idle' },
            message: '等待连接',
          },
        },
      }),
    );
    await page.route('**/local/v1/rivalhub-connection', (route) =>
      route.fulfill({
        json: {
          paired: true,
          sourceReady: false,
          activeMatchId: null,
          sourceBlockedReason: '当前比赛资料不完整，请核对双方十人名单与比赛连接后重试。',
        },
      }),
    );
    await page.setViewportSize({ width: 1280, height: 240 });
    await page.goto('/workspace/dock');
    const camera = page.getByRole('region', { name: '运镜控制', exact: true });
    await expect(camera).toHaveCount(mode === 'mulnx' || mode === 'connected' ? 1 : 0);
    await expect(page.getByText('键位可能持久变化', { exact: false })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '准备并复制解说配置命令' })).toHaveCount(0);
    const sync = page.getByRole('button', { name: '比赛同步 · 待处理' });
    await expect(sync).toBeVisible();
    const bounds = await page.locator('.workspace-footer-actions > *').evaluateAll((elements) =>
      elements.map((element) => {
        const r = element.getBoundingClientRect();
        return { left: r.left, right: r.right, bottom: r.bottom };
      }),
    );
    for (let i = 1; i < bounds.length; i++)
      expect(bounds[i]!.left).toBeGreaterThanOrEqual(bounds[i - 1]!.right);
    expect(bounds.at(-1)!.right).toBeLessThanOrEqual(1280);
    expect(bounds.at(-1)!.bottom).toBeLessThanOrEqual(240);
    const config = page.getByRole('button', { name: '解说配置', exact: true });
    await expect(config).toHaveCount(0);
    await page.screenshot({ path: `.agent-tmp/workspace-${mode}.png` });
  });
}

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
