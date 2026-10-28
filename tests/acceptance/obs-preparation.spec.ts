import { test, expect } from './companion-isolation.js';

test('different check and preparation findings do not repeat configuration writes', async ({
  page,
}) => {
  let ensures = 0;
  let reads = 0;
  await page.route('**/local/v1/obs', (route) => {
    reads++;
    return route.fulfill({
      json: {
        connection: 'connected',
        currentScene: 'Mizar · 赛前等待',
        port: 4455,
        streaming: false,
        recording: false,
        passwordConfigured: true,
        video: null,
        findings: [{ code: 'audio_missing', message: '音频待检查' }],
        sceneAligned: true,
      },
    });
  });
  await page.route('**/operator/obs/ensure', (route) => {
    ensures++;
    return route.fulfill({
      json: { findings: [{ code: 'commentary_pending', message: '等待解说音频' }] },
    });
  });
  await page.goto('/');
  await expect.poll(() => ensures).toBe(1);
  const afterEnsure = reads;
  await expect.poll(() => reads, { timeout: 12000 }).toBeGreaterThanOrEqual(afterEnsure + 4);
  expect(ensures).toBe(1);
});

test('first connection prepares scenes and audio without extra setup clicks, and exposes remaining audio problems', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 2560, height: 1440 });
  let connected = false;
  let output = false;
  let findings = [{ code: 'collection_missing', message: '尚未创建 Mizar 场景集合。' }];
  let release: (() => void) | undefined;
  let completed = false;
  let ensureCount = 0;
  const requests: string[] = [];
  await page.route('**/local/v1/obs', (route) =>
    route.fulfill({
      json: {
        connection: connected ? 'connected' : 'password_required',
        currentScene: connected ? 'Mizar · 等待' : null,
        port: 4455,
        streaming: output,
        recording: false,
        passwordConfigured: connected,
        video: null,
        findings,
        sceneAligned: true,
      },
    }),
  );
  await page.route('**/operator/obs/*', async (route) => {
    const action = new URL(route.request().url()).pathname.split('/').at(-1)!;
    requests.push(action);
    if (action === 'configure') {
      expect(route.request().postDataJSON()).toEqual({
        port: 4455,
        password: 'test-only-password',
      });
      connected = true;
    }
    if (action === 'ensure') {
      ensureCount++;
      expect(output).toBe(false);
      if (!completed) {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        completed = true;
        findings = [];
      }
    }
    await route.fulfill({ json: { ok: true, findings } });
  });
  await page.goto('/settings?tab=obs');
  await expect(page.getByLabel('WebSocket 密码', { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('01-connect.png') });
  await page.getByLabel('WebSocket 密码', { exact: true }).fill('test-only-password');
  await page.getByRole('button', { name: '保存并测试', exact: true }).click();
  await expect(page.getByText(/正在准备 Mizar 场景与音频/)).toBeVisible();
  await expect.poll(() => Boolean(release)).toBe(true);
  await expect(page.getByText(/音频配置检查通过/)).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('02-preparing.png') });
  release!();
  await page.goto('/settings?tab=music');
  await page.getByRole('button', { name: '音源', exact: true }).click();
  await expect(page.getByText(/音频配置检查通过/)).toBeVisible();

  await page.screenshot({ path: testInfo.outputPath('03-ready.png') });
  expect(requests.filter((action) => ['repair', 'audio-setup'].includes(action))).toEqual([]);

  // Real output facts defer automatic mutation; stopping resumes without a setup click.
  output = true;
  findings = [{ code: 'audio_missing', message: '当前没有音频来源。' }];
  await expect(page.getByText(/自动配置暂缓/)).toBeVisible();
  const before = ensureCount;
  await expect(page.getByRole('button', { name: '重试音频自动配置', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '重试音频自动配置', exact: true })).toBeDisabled();
  await page.screenshot({ path: testInfo.outputPath('04-deferred.png') });
  expect(ensureCount).toBe(before);
  output = false;
  await expect.poll(() => ensureCount).toBeGreaterThan(before);
  await expect(page.getByText('当前没有音频来源。', { exact: true }).last()).toBeVisible();
  await expect(page.getByRole('button', { name: '重试音频自动配置', exact: true })).toBeEnabled();
});
