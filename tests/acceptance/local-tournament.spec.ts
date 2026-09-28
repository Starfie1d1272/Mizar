import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildApp } from '../../apps/companion/src/app.js';
import { expect, test } from './companion-isolation.js';

test('Preparation flow creates and edits a local match before BP', async ({ page, context }) => {
  const directory = await mkdtemp(join(tmpdir(), 'mizar-local-ui-'));
  const app = buildApp({
    matchManifestPath: join(directory, 'match.json'),
    localTournamentPath: join(directory, 'tournament.json'),
  });
  try {
    await app.ready();
    await context.route(
      /\/(?:local\/v1\/tournament|operator\/local-match\/(?:create|save))$/,
      async (route) => {
        const request = route.request();
        const response = await app.inject({
          method: request.method() as 'GET' | 'POST',
          url: new URL(request.url()).pathname,
          headers: request.headers(),
          ...(request.postData() === null ? {} : { payload: request.postData()! }),
        });
        await route.fulfill({
          status: response.statusCode,
          body: response.body,
          contentType: String(response.headers['content-type'] ?? 'application/json'),
        });
      },
    );
    await page.goto('/matches');
    const form = page.locator('.workspace-local-match form').first();
    await form.locator('input').nth(0).fill('甲队');
    await form.locator('input').nth(1).fill('乙队');
    await form.getByRole('button', { name: '创建本地比赛' }).click();
    await expect(page.locator('.workspace-local-match select').last()).toContainText(
      '甲队 vs 乙队',
    );
    await expect(page.getByRole('button', { name: '保存比赛资料' })).toBeVisible();
    const bp = await app.inject({ url: '/local/v1/bp-workspace' });
    expect(bp.json<{ readiness: string }>().readiness).toBe('missing');
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
