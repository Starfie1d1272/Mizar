import { test, expect } from './companion-isolation.js';

test('explicitly selects an OBS source and reports stale bindings', async ({ page }, testInfo) => {
  const revision = '00000000-0000-4000-8000-000000000001';
  const status = {
    revision,
    endpoint: 'ws://127.0.0.1:4455',
    collection: 'Mizar',
    bindings: { game: null, remoteCommentary: null, microphone: null },
    candidates: [
      {
        selectionId: '00000000-0000-4000-8000-000000000002',
        name: 'TeamSpeak 3',
        kind: 'wasapi_process_output_capture',
        uuid: 'one',
      },
      {
        selectionId: '00000000-0000-4000-8000-000000000003',
        name: 'TeamSpeak 6',
        kind: 'wasapi_process_output_capture',
        uuid: 'two',
      },
    ],
    findings: ['桌面音频可能包含应用音频和音乐监听；请在 OBS 中核对并自行迁移。'],
  };
  let bound = false;
  let policy = { mode: 'keep' } as { mode: string; db?: number };
  await page.route('**/local/v1/obs/remote-commentary', (route) =>
    route.fulfill({
      json: { revision, preference: { mode: bound ? 'existingInput' : 'autoTeamspeak' } },
    }),
  );
  await page.route('**/local/v1/obs/game-audio-policy', (route) =>
    route.fulfill({ json: { ready: true, policy, revision, ownership: 'idle' } }),
  );
  await page.route('**/operator/obs/game-audio-policy', (route) => {
    policy = (route.request().postDataJSON() as { policy: typeof policy }).policy;
    return route.fulfill({ json: { ready: true, policy, revision, ownership: 'idle' } });
  });
  await page.route('**/local/v1/obs/audio-routing', (route) =>
    route.fulfill({
      json: bound
        ? {
            ...status,
            bindings: {
              ...status.bindings,
              remoteCommentary: {
                inputUuid: 'two',
                inputKind: status.candidates[1]!.kind,
                collection: 'Mizar',
                endpoint: status.endpoint,
                valid: true,
                name: 'TeamSpeak 6',
              },
            },
          }
        : status,
    }),
  );
  await page.route('**/operator/obs/audio-routing', (route) => {
    expect(route.request().postDataJSON()).toEqual({
      role: 'remoteCommentary',
      selectionId: status.candidates[1]!.selectionId,
      revision,
    });
    bound = true;
    return route.fulfill({ json: { ok: true } });
  });
  await page.goto('/settings?tab=music');
  await page.getByRole('button', { name: '音源', exact: true }).click();
  await page.getByText('手动绑定与来源详情').click();
  await page.getByRole('button', { name: '刷新 OBS 音频来源' }).click();
  await expect(page.getByText(/当前 OBS：ws:/)).toBeVisible();
  const source = page.getByLabel('远端解说音频');
  for (const [width, height] of [
    [1280, 720],
    [1920, 720],
    [600, 650],
  ] as const) {
    await page.setViewportSize({ width, height });
    expect((await source.boundingBox())!.height).toBeGreaterThanOrEqual(32);
    expect(
      await page.locator('.product-content').evaluate((el) => el.scrollWidth <= el.clientWidth),
    ).toBe(true);
  }
  await expect(source.locator('option').nth(2)).toHaveText('TeamSpeak 6 · 应用音频');
  await expect(source).not.toContainText('wasapi_process_output_capture');
  await source.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('source-narrow.png') });
  await page.getByLabel('远端解说音频').selectOption(status.candidates[1]!.selectionId);
  await expect(page.getByText('已绑定：TeamSpeak 6')).toBeVisible();
  await expect(page.getByText(/桌面音频可能包含/)).toBeVisible();
  await page.getByRole('button', { name: '场景策略', exact: true }).click();
  await page.getByLabel('中场策略').selectOption('attenuate');
  await page.getByRole('button', { name: '保存中场策略' }).click();
  await expect.poll(() => policy).toEqual({ mode: 'attenuate', db: 6 });
  await expect(page.getByRole('status').filter({ hasText: '中场策略已保存。' })).toBeVisible();
  await page.getByText('中场策略已保存。').scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('policy-saved-narrow.png') });
  await page.getByLabel('中场策略').selectOption('mute');
  await expect(page.getByText('中场策略已保存。')).toBeHidden();
  await page.screenshot({ path: testInfo.outputPath('audio-routing.png'), fullPage: true });
});

test('does not report a policy save when readback differs or is unavailable', async ({ page }) => {
  let readFailure = false;
  await page.route('**/local/v1/obs/game-audio-policy', (route) =>
    readFailure
      ? route.fulfill({ status: 503 })
      : route.fulfill({
          json: { ready: true, revision: 'v1', policy: { mode: 'keep' }, ownership: 'idle' },
        }),
  );
  await page.route('**/operator/obs/game-audio-policy', (route) =>
    route.fulfill({ json: { ok: true } }),
  );
  await page.goto('/settings?tab=music');
  await page.getByRole('button', { name: '场景策略' }).click();
  await page.getByLabel('中场策略').selectOption('mute');
  await page.getByRole('button', { name: '保存中场策略' }).click();
  await expect(
    page.getByRole('alert').filter({ hasText: '保存后的策略与所选设置不一致' }),
  ).toBeVisible();
  await expect(page.getByText('中场策略已保存。')).toBeHidden();
  readFailure = true;
  await page.getByRole('button', { name: '保存中场策略' }).click();
  await expect(
    page.getByRole('alert').filter({ hasText: '操作已提交，但无法读取结果' }),
  ).toBeVisible();
});

test('an older poll cannot replace the saved policy status', async ({ page }) => {
  let reads = 0;
  let saved = false;
  let releasePoll!: () => void;
  let pollFinished!: () => void;
  const delayed = new Promise<void>((resolve) => {
    releasePoll = resolve;
  });
  const finished = new Promise<void>((resolve) => {
    pollFinished = resolve;
  });
  await page.route('**/local/v1/obs/game-audio-policy', async (route) => {
    reads++;
    if (reads === 2) {
      await delayed;
      await route.fulfill({
        json: { ready: true, revision: 'old', policy: { mode: 'keep' }, ownership: 'held' },
      });
      pollFinished();
      return;
    }
    return route.fulfill({
      json: {
        ready: true,
        revision: saved ? 'new' : 'old',
        policy: { mode: saved ? 'mute' : 'keep' },
        ownership: 'idle',
      },
    });
  });
  await page.route('**/operator/obs/game-audio-policy', (route) => {
    saved = true;
    return route.fulfill({ json: { ok: true } });
  });
  await page.goto('/settings?tab=music');
  await page.getByRole('button', { name: '场景策略' }).click();
  await expect.poll(() => reads).toBeGreaterThanOrEqual(2);
  await page.getByLabel('中场策略').selectOption('mute');
  await page.getByRole('button', { name: '保存中场策略' }).click();
  await expect(page.getByText('中场策略已保存。')).toBeVisible();
  releasePoll();
  await finished;
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await expect(page.getByText('游戏音频的自动控制已暂停。', { exact: false })).toHaveCount(0);
  await expect(page.getByText('中场策略已保存。')).toBeVisible();
});

test('chooses another application, cancels, reselects and explicitly restores TS', async ({
  page,
}, testInfo) => {
  const revision = '00000000-0000-4000-8000-000000000001';
  const first = '00000000-0000-4000-8000-000000000002';
  const second = '00000000-0000-4000-8000-000000000003';
  const longTitle = 'Voice application with a very long window title '.repeat(8);
  let mode = 'autoTeamspeak';
  let chosen = '';
  let activeOutput = false;
  await page.route('**/local/v1/obs/remote-commentary', (route) =>
    route.fulfill({
      json: {
        revision,
        preference: {
          mode,
          ...(mode === 'application'
            ? { window: `${chosen === first ? 'Voice One' : longTitle}:Qt:voice.exe` }
            : {}),
        },
      },
    }),
  );
  await page.route('**/operator/obs/remote-commentary/applications', (route) =>
    route.fulfill({
      json: {
        revision,
        candidates: [
          { id: first, label: 'Voice One' },
          { id: second, label: longTitle },
        ],
      },
    }),
  );
  await page.route('**/operator/obs/remote-commentary/application', (route) => {
    chosen = (route.request().postDataJSON() as { selectionId: string }).selectionId;
    mode = 'application';
    return route.fulfill({ json: { revision, preference: { mode } } });
  });
  await page.route('**/operator/obs/remote-commentary', (route) => {
    mode = (route.request().postDataJSON() as { mode: string }).mode;
    return route.fulfill({ json: { revision, preference: { mode } } });
  });
  await page.route('**/operator/obs/ensure', (route) =>
    route.fulfill({
      json: {
        findings: [
          {
            code: 'commentary_pending',
            message: activeOutput
              ? 'OBS 正在输出；停止输出后请重新配置远端解说音频。'
              : '等待所选应用启动；场景已准备，音频分路待完成。',
          },
        ],
      },
    }),
  );
  await page.goto('/settings?tab=music');
  await page.getByRole('button', { name: '音源', exact: true }).click();
  await page.getByRole('button', { name: '选择其他应用' }).click();
  await page.getByLabel('应用窗口').selectOption(first);
  await page.getByRole('button', { name: '取消', exact: true }).click();
  expect(chosen).toBe('');
  await page.getByRole('button', { name: '选择其他应用' }).click();
  await page.getByLabel('应用窗口').selectOption(first);
  await page.getByRole('button', { name: '保存应用' }).click();
  await expect(page.getByText('当前：已选择应用：Voice One')).toBeVisible();
  await expect(page.getByText(/等待所选应用启动/)).toBeVisible();
  expect(chosen).toBe(first);
  await page.reload();
  await page.getByRole('button', { name: '音源', exact: true }).click();
  await expect(page.getByText('当前：已选择应用：Voice One')).toBeVisible();
  await page.getByRole('button', { name: '选择其他应用' }).click();
  await page.getByLabel('应用窗口').selectOption(second);
  const fits = await page.getByLabel('应用窗口').evaluate((element) => {
    const select = element.getBoundingClientRect();
    const container = element.parentElement!.getBoundingClientRect();
    return select.right <= container.right && select.left >= container.left;
  });
  expect(fits).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('application-selection.png'), fullPage: true });
  activeOutput = true;
  await page.getByRole('button', { name: '保存应用' }).click();
  expect(chosen).toBe(second);
  await expect(page.getByText(`当前：已选择应用：${longTitle.trim()}`)).toBeVisible();
  await expect(page.getByText(/OBS 正在输出；停止输出后请重新配置远端解说音频/)).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath('application-selected-long.png'),
    fullPage: true,
  });
  await page.getByRole('button', { name: '自动识别 TeamSpeak' }).click();
  await expect(page.getByText('当前：自动识别 TeamSpeak')).toBeVisible();
  expect(mode).toBe('autoTeamspeak');
});
