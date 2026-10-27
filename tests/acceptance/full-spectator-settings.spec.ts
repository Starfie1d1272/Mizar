import { test, expect } from './companion-isolation.js';

test('account-scoped spectator opt-in saves explicitly and shows recovery warning', async ({
  page,
  context,
}) => {
  const calls: { command: string; args?: Record<string, unknown> }[] = [];
  await context.exposeBinding(
    'fullSpectatorNative',
    (_source, command: string, args?: Record<string, unknown>) => {
      calls.push({ command, args });
      if (command === 'get_full_spectator_preference') return { account: 42, enabled: false };
      if (command === 'cs2_config_status')
        return {
          qualityPreset: 'high',
          frameRateLimit: 60,
          preferMulnx: false,
          pending: false,
          running: false,
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
  const checkbox = page.getByRole('checkbox', { name: '为当前 Steam 账号启用完整解说键位' });
  await expect(checkbox).not.toBeChecked();
  await checkbox.click();
  await expect(checkbox).toBeChecked();
  expect(calls.filter((call) => call.command === 'set_full_spectator_preference')).toMatchObject([
    { command: 'set_full_spectator_preference', args: { account: 42, enabled: true } },
  ]);
  await expect(
    page.getByText('观战键位已被其他程序修改，保留当前配置和原备份；请核对后重试。'),
  ).toBeVisible();
  await page
    .getByRole('heading', { name: 'CS2 启动设置' })
    .locator('..')
    .screenshot({ path: '.agent-tmp/full-spectator-settings.png' });
});
