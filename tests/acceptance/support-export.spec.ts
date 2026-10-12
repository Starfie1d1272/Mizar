import { readFile } from 'node:fs/promises';
import { buildApp } from '../../apps/companion/src/app.js';
import { expect, test } from './companion-isolation.js';

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
      snapshot: { runtime: { freshness: string }; nativeObs: { collectionStatus: string } };
    };
    expect(result.schema).toBe('mizar-support-bundle/1');
    expect(result.manifest).toMatchObject({
      gitSha: 'a'.repeat(40),
      artifactSha256: 'b'.repeat(64),
    });
    expect(result.snapshot.runtime.freshness).toBe('awaiting');
    if (process.platform === 'win32')
      expect(['available', 'failed', 'timeout']).toContain(
        result.snapshot.nativeObs.collectionStatus,
      );
    else expect(result.snapshot.nativeObs.collectionStatus).toBe('unsupported');
    await testInfo.attach('support-export-real-ui', {
      body: await page.screenshot(),
      contentType: 'image/png',
    });
    expect(bytes.byteLength).toBeLessThanOrEqual(256 * 1024);
    expect(bytes.toString('utf8')).not.toContain('private-');
    expect(errors).toEqual([]);
  } finally {
    await app.close();
  }
});
