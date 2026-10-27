import { test, expect } from './companion-isolation.js';

test('spectator controls are available without an account opt-in and show recovery warnings', async ({
  page,
  context,
}) => {
  const calls: { command: string; args?: Record<string, unknown> }[] = [];
  await context.exposeBinding(
    'fullSpectatorNative',
    (_source, command: string, args?: Record<string, unknown>) => {
      calls.push({ command, ...(args ? { args } : {}) });
      if (command === 'cs2_config_status')
        return {
          qualityPreset: 'high',
          frameRateLimit: 60,
          preferMulnx: false,
          pending: false,
          running: true,
          nativeHudToggle: true,
          busy: false,
          message: null,
          spectatorWarning: '观战键位已被其他程序修改，保留当前配置和原备份；请核对后重试。',
        };
      if (command === 'workspace_exit_status') return { busy: false, stage: '', message: null };
      if (command === 'gsi_status') return { detected: true, installed: true, conflict: false };
      return null;
    },
  );
  await context.addInitScript(() =>
    Object.assign(window, {
      __TAURI_INTERNALS__: {
        invoke: (command: string, args?: Record<string, unknown>) =>
          (
            window as typeof window & {
              fullSpectatorNative: (
                command: string,
                args?: Record<string, unknown>,
              ) => Promise<unknown>;
            }
          ).fullSpectatorNative(command, args),
      },
    }),
  );
  await page.goto('/settings?tab=gsi');
  await expect(
    page.getByRole('checkbox', { name: '为当前 Steam 账号启用完整解说键位' }),
  ).toHaveCount(0);
  await expect(page.getByText('按 H 切换 CS2 原生 HUD', { exact: true })).toBeVisible();
  expect(calls.some((call) => /full_spectator_preference/.test(call.command))).toBe(false);
  await expect(
    page.getByText('观战键位已被其他程序修改，保留当前配置和原备份；请核对后重试。'),
  ).toBeVisible();
  await page
    .getByRole('heading', { name: 'CS2 启动设置' })
    .locator('..')
    .screenshot({ path: '.agent-tmp/full-spectator-settings.png' });
});
