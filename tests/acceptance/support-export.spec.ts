import { readFile } from 'node:fs/promises';
import { buildApp } from '../../apps/companion/src/app.js';
import { expect, test } from './companion-isolation.js';

const bundle = {
  schema: 'mizar-support-bundle/1',
  manifest: { gitSha: 'a'.repeat(40) },
  summary: ['安全摘要'],
  snapshot: {},
  logs: [],
};

test('normal UI downloads the real Companion allowlist export through the local proxy', async ({
  page,
}, testInfo) => {
  const app = buildApp({
    productRuntime: {
      gitSha: 'a'.repeat(40),
      artifactSha256: 'b'.repeat(64),
      instanceId: 'private-instance',
      controlToken: 'private-token',
      stop() {},
    },
  });
  try {
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    await page.route('**/debug/support-bundle', async (route) => {
      const response = await route.fetch({ url: `${address}/debug/support-bundle` });
      await route.fulfill({ response });
    });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto('/debug');
    await expect(page.getByRole('heading', { name: '运行诊断', exact: true })).toBeVisible();
    const downloading = page.waitForEvent('download');
    await page.getByRole('button', { name: '导出诊断包', exact: true }).click();
    const download = await downloading;
    const bytes = await readFile(await download.path());
    const result = JSON.parse(bytes.toString('utf8')) as {
      schema: string;
      manifest: unknown;
      snapshot: { runtime: { freshness: string } };
    };
    expect(result.schema).toBe('mizar-support-bundle/1');
    expect(result.manifest).toMatchObject({
      gitSha: 'a'.repeat(40),
      artifactSha256: 'b'.repeat(64),
    });
    expect(result.snapshot.runtime.freshness).toBe('awaiting');
    expect(bytes.byteLength).toBeLessThanOrEqual(256 * 1024);
    expect(bytes.toString('utf8')).not.toContain('private-');
    expect(errors).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath('support-export.png'), fullPage: true });
  } finally {
    await app.close();
  }
});

test('settings exposes diagnostics export and the browser downloads a JSON bundle with retry', async ({
  page,
}) => {
  await page.goto('/settings?tab=advanced');
  await expect(page.getByRole('button', { name: '运行诊断 / 导出诊断包' })).toBeVisible();
  let attempts = 0;
  await page.route('**/debug/support-bundle', (route) => {
    attempts += 1;
    return route.fulfill({
      status: attempts === 1 ? 503 : 200,
      contentType: 'application/json',
      body: JSON.stringify(bundle),
    });
  });
  await page.goto('/debug');
  const button = page.getByRole('button', { name: '导出诊断包', exact: true });
  await button.focus();
  await expect(button).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('alert').filter({ hasText: '诊断包未能导出' })).toBeVisible();
  await expect(button).toBeEnabled();
  const downloading = page.waitForEvent('download');
  await button.click();
  const download = await downloading;
  expect(download.suggestedFilename()).toMatch(/^mizar-support-.*\.json$/);
  expect(JSON.parse(await readFile(await download.path(), 'utf8'))).toEqual(bundle);
  await expect(page.getByRole('status').filter({ hasText: '已发起下载' })).toBeVisible();
});

test('desktop save reports cancellation, failure and success, omitting private Host fields', async ({
  page,
}) => {
  await page.addInitScript(() => {
    let saves = 0;
    Object.assign(window, {
      __TAURI_INTERNALS__: {
        async invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
          await new Promise((resolve) => setTimeout(resolve, 10));
          if (command === 'gsi_status')
            return {
              installed: true,
              cfgPath: 'C:\\Users\\Private\\gsi.cfg',
              token: 'secret',
            } as T;
          if (command === 'cs2_host_status')
            return { found: true, managed: false, title: 'private' } as T;
          if (command === 'save_support_bundle') {
            if (
              typeof args?.contents !== 'string' ||
              (JSON.parse(args.contents) as { schema?: string }).schema !== 'mizar-support-bundle/1'
            )
              throw new Error('wrong bundle');
            saves += 1;
            if (saves === 2) throw new Error('write denied');
            return (saves === 3) as T;
          }
          return null as T;
        },
      },
    });
  });
  const payloads: unknown[] = [];
  await page.route('**/debug/support-bundle', (route) => {
    payloads.push(route.request().postDataJSON());
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(bundle) });
  });
  await page.goto('/debug');
  const button = page.getByRole('button', { name: '导出诊断包', exact: true });
  await button.click();
  await expect(page.getByRole('status').filter({ hasText: '已取消保存' })).toBeVisible();
  await button.click();
  await expect(page.getByRole('alert').filter({ hasText: '诊断包未能导出' })).toBeVisible();
  await button.click();
  await expect(page.getByRole('status').filter({ hasText: '诊断包已保存' })).toBeVisible();
  expect(payloads).toHaveLength(3);
  expect(payloads[0]).toEqual({
    desktop: {
      gsi: { collectionStatus: 'available', installed: true, issueCodes: [], lastOperation: null },
      cs2: { collectionStatus: 'available', found: true, managed: false },
    },
  });
});

for (const collectionStatus of ['failed', 'timeout'] as const) {
  test(`Host status ${collectionStatus} is recorded distinctly without blocking export`, async ({
    page,
  }) => {
    await page.addInitScript((state) => {
      Object.assign(window, {
        __TAURI_INTERNALS__: {
          async invoke<T>(command: string): Promise<T> {
            if (command === 'save_support_bundle') return true as T;
            if (state === 'failed') throw new Error('private-local-error');
            return new Promise<T>(() => {});
          },
        },
      });
    }, collectionStatus);
    let payload: unknown;
    await page.route('**/debug/support-bundle', (route) => {
      payload = route.request().postDataJSON();
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(bundle) });
    });
    await page.goto('/debug');
    await page.getByRole('button', { name: '导出诊断包', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: '诊断包已保存' })).toBeVisible({
      timeout: 10_000,
    });
    expect(payload).toEqual({
      desktop: {
        gsi: { collectionStatus, issueCodes: [], lastOperation: null },
        cs2: { collectionStatus },
      },
    });
    expect(JSON.stringify(payload)).not.toContain('private-local-error');
  });
}
