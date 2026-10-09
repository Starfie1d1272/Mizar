import { expect, test } from './companion-isolation.js';
import { PROGRAM_SCENES } from '../../packages/protocol/src/program-scenes.js';

test('Desktop HUD scales inside its viewport without native scrollbars', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      value: { invoke: () => Promise.resolve(undefined) },
    });
  });
  await page.setViewportSize({ width: 1216, height: 684 });
  await page.goto('/program?host=desktop');
  await expect(page.locator('.program-desktop-viewport')).toBeVisible();
  for (const size of [
    { width: 1216, height: 684 },
    { width: 800, height: 450 },
    { width: 1920, height: 1080 },
  ]) {
    await page.setViewportSize(size);
    await expect
      .poll(() =>
        page.locator('.program-canvas').evaluate((canvas) => ({
          width: Math.round(canvas.getBoundingClientRect().width),
          height: Math.round(canvas.getBoundingClientRect().height),
          scrollWidth: document.documentElement.scrollWidth,
          scrollHeight: document.documentElement.scrollHeight,
        })),
      )
      .toEqual({
        width: size.width,
        height: size.height,
        scrollWidth: size.width,
        scrollHeight: size.height,
      });
  }
});

for (const [width, height] of [
  [1920, 1080],
  [2560, 1440],
] as const) {
  for (const scale of [1, 1.25, 1.5]) {
    test(`Workspace controls fit ${width}×${height} at ${scale * 100}% without scrolling or clipping`, async ({
      page,
    }) => {
      await page.route('**/local/v1/program-scenes', (route) =>
        route.fulfill({
          json: {
            schemaVersion: 'mizar.program-scenes.v1',
            active: 'waiting',
            revision: 'density-1',
            available: PROGRAM_SCENES.map((scene) => scene.id),
            blocked: {},
            director: {
              mode: 'blocked',
              next: null,
              reason: '等待比赛数据，请检查 CS2 与 GSI。',
              introDurationMs: 3000,
              sceneElapsedMs: 0,
            },
          },
        }),
      );
      await page.route('**/local/v1/production', (route) =>
        route.fulfill({ json: { mode: 'live', revision: 'live-1', canEnter: true } }),
      );
      await page.route('**/local/v1/rivalhub-connection', (route) =>
        route.fulfill({
          json: {
            paired: true,
            activeMatchId: 'density-match',
            activeSourceMatchId: 'density-match',
            activeDeviceName: '验收设备',
          },
        }),
      );
      await page.addInitScript(() => {
        Object.assign(window, {
          __TAURI_INTERNALS__: {
            invoke: (command: string) => {
              if (command === 'restore_layout')
                return Promise.reject(
                  new Error('工作区已恢复，但 CS2 未接受窗口尺寸。请使用窗口模式后重试恢复布局。'),
                );
              return Promise.resolve(true);
            },
          },
        });
        Object.defineProperty(navigator, 'clipboard', { value: { writeText: async () => {} } });
      });
      // Mirrors the Host's integer geometry and a 48-logical-pixel taskbar.
      const workHeight = height - 48 * scale;
      const units = Math.floor(
        Math.min(Math.floor(width * 0.75) / 16, Math.floor(workHeight * 0.75) / 9),
      );
      const gameWidth = units * 16;
      const gameHeight = units * 9;
      await page.setViewportSize({
        width: Math.floor(gameWidth / scale),
        height: Math.floor((workHeight - gameHeight) / scale),
      });
      await page.goto('/workspace/dock');
      await expect(page.getByRole('button', { name: '现场恢复' })).toBeVisible();
      await expect(page.locator('.workspace-next-summary')).toContainText('预告尚未执行');
      if (process.env.MIZAR_REVIEW_SCREENSHOTS)
        await page.screenshot({
          path: `${process.env.MIZAR_REVIEW_SCREENSHOTS}/dock-${height}-${scale * 100}.png`,
        });
      const measureDock = () =>
        page.locator('.workspace-dock').evaluate((root) => {
          const bounds = root.getBoundingClientRect();
          const clipped = Array.from(
            root.querySelectorAll(
              'button,.workspace-next-summary,.workspace-direction > header,.workspace-obs-scene',
            ),
          )
            .filter((button) => {
              if (!button.getClientRects().length) return false;
              const r = button.getBoundingClientRect();
              const section = button.closest('section')?.getBoundingClientRect();
              return (
                r.left < bounds.left - 1 ||
                r.right > bounds.right + 1 ||
                r.top < bounds.top - 1 ||
                r.bottom > bounds.bottom + 1 ||
                (section !== undefined && r.bottom > section.bottom + 1) ||
                (button.tagName === 'BUTTON' && button.scrollWidth > button.clientWidth + 1) ||
                r.height < 1
              );
            })
            .map((button) => button.textContent);
          const overflow = Array.from(root.querySelectorAll('section'))
            .filter(
              (el) => el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1,
            )
            .map((el) => ({
              label: el.getAttribute('aria-label'),
              width: el.clientWidth,
              scrollWidth: el.scrollWidth,
              height: el.clientHeight,
              scrollHeight: el.scrollHeight,
            }));
          return {
            clipped,
            overflow,
            documentScroll: document.documentElement.scrollHeight > innerHeight + 1,
          };
        });
      expect(await measureDock()).toEqual({ clipped: [], overflow: [], documentScroll: false });
      let finishTake: (() => void) | undefined;
      await page.route('**/operator/program-scene', async (route) => {
        await new Promise<void>((resolve) => {
          finishTake = resolve;
        });
        await route.fulfill({ json: { ok: true } });
      });
      await page.getByRole('button', { name: '赛前等待', exact: true }).click();
      await expect(page.getByRole('button', { name: '赛前等待', exact: true })).toBeDisabled();
      await expect(page.locator('.workspace-next-summary')).toContainText('预告尚未执行');
      expect(await measureDock()).toEqual({ clipped: [], overflow: [], documentScroll: false });
      if (process.env.MIZAR_REVIEW_SCREENSHOTS)
        await page.screenshot({
          path: `${process.env.MIZAR_REVIEW_SCREENSHOTS}/dock-${height}-${scale * 100}-busy.png`,
        });
      finishTake?.();
      await expect(page.getByRole('button', { name: '赛前等待', exact: true })).toBeEnabled();
      await page.getByRole('button', { name: '观战 / 本机 HUD', exact: true }).click();
      await expect(page.getByRole('button', { name: '复制隐藏命令', exact: true })).toBeVisible();
      expect(await measureDock()).toEqual({ clipped: [], overflow: [], documentScroll: false });
      await page.setViewportSize({
        width: Math.floor((width - gameWidth) / scale),
        height: Math.floor(workHeight / scale),
      });
      await page.goto('/workspace/left');
      await expect(page.getByText('等待 GSI 数据', { exact: true })).toBeVisible();
      const leftOverflow = await page.locator('.workspace-left').evaluate((root) => {
        const bounds = root.getBoundingClientRect();
        return {
          overflow: root.scrollHeight > root.clientHeight + 1,
          clipped: Array.from(root.querySelectorAll('button,a'))
            .filter((el) => {
              const r = el.getBoundingClientRect();
              let ancestor = el.parentElement;
              while (ancestor && ancestor !== root) {
                if (getComputedStyle(ancestor).overflow === 'hidden') {
                  const clip = ancestor.getBoundingClientRect();
                  if (
                    r.bottom > clip.bottom + 1 ||
                    r.top < clip.top - 1 ||
                    r.left < clip.left - 1 ||
                    r.right > clip.right + 1
                  )
                    return true;
                }
                ancestor = ancestor.parentElement;
              }
              return (
                r.left < bounds.left - 1 ||
                r.right > bounds.right + 1 ||
                r.top < bounds.top - 1 ||
                r.bottom > bounds.bottom + 1
              );
            })
            .map((el) => el.textContent),
        };
      });
      expect(leftOverflow).toEqual({ overflow: false, clipped: [] });
      await page.getByRole('button', { name: '检查游戏连接' }).focus();
      await expect(page.getByRole('button', { name: '检查游戏连接' })).toBeFocused();
    });
  }
}

for (const connection of ['unavailable', 'password_required', 'invalid_password', 'connected']) {
  test(`Entry checks the current OBS ${connection} state before changing production`, async ({
    page,
  }) => {
    let entered = 0;
    await page.route('**/local/v1/production', (route) =>
      route.fulfill({ json: { mode: 'preparation', revision: 'preparation-1', canEnter: true } }),
    );
    await page.route('**/local/v1/obs', (route) =>
      route.fulfill({ json: { connection, findings: [], port: 4455 } }),
    );
    await page.route('**/operator/production', (route) => {
      entered++;
      return route.fulfill({ json: { ok: true } });
    });
    await page.goto('/');
    await page.getByRole('button', { name: '进入制播工作区', exact: true }).click();
    if (connection === 'connected') {
      await expect(page).toHaveURL(/\/workspace$/);
      expect(entered).toBe(1);
    } else {
      await expect(page).toHaveURL(/\/settings\?tab=obs&prepare=1$/);
      await expect(page.getByRole('heading', { name: '启动游戏前，连接并检查 OBS' })).toBeVisible();
      await expect(page.getByLabel('WebSocket 密码')).toBeVisible();
      expect(entered).toBe(0);
    }
  });
}

test('Connected OBS with missing scene configuration stays in preparation', async ({ page }) => {
  let entered = 0;
  await page.route('**/local/v1/production', (route) =>
    route.fulfill({ json: { mode: 'preparation', revision: 'preparation-1', canEnter: true } }),
  );
  await page.route('**/local/v1/obs', (route) =>
    route.fulfill({
      json: {
        connection: 'connected',
        port: 4455,
        findings: [{ code: 'missing_scene', message: '缺少 Mizar 场景' }],
      },
    }),
  );
  await page.route('**/operator/production', (route) => {
    entered++;
    return route.fulfill({ json: { ok: true } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: '进入制播工作区', exact: true }).click();
  await expect(page).toHaveURL(/prepare=1$/);
  await expect(page.getByText('缺少 Mizar 场景', { exact: true })).toBeVisible();
  expect(entered).toBe(0);
});

for (const gsi of [
  { installed: false, conflict: false },
  { installed: true, conflict: true },
]) {
  test(`Desktop entry requires installed conflict-free GSI: ${JSON.stringify(gsi)}`, async ({
    page,
  }) => {
    await page.addInitScript((status) => {
      Object.assign(window, {
        __TAURI_INTERNALS__: {
          invoke: (command: string) => {
            if (command === 'start_managed_cs2') throw new Error('must not launch');
            return Promise.resolve(
              command === 'gsi_status' ? status : { pending: false, running: false },
            );
          },
        },
      });
    }, gsi);
    await page.route('**/local/v1/production', (route) =>
      route.fulfill({ json: { mode: 'preparation', revision: 'preflight', canEnter: true } }),
    );
    await page.goto('/');
    await page.getByRole('button', { name: '启动新制作并进入现场', exact: true }).click();
    await expect(page).toHaveURL(/settings\?tab=gsi&prepare=1$/);
  });
}
