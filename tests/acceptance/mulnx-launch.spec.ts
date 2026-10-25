import { test, expect } from './companion-isolation.js';
import { emptyOrchestrationPreset } from '../../packages/protocol/src/orchestration.js';

// Native calls are browser contract doubles; no real launcher, CS2 or OBS is used.
for (const entry of ['/', '/settings?tab=gsi']) {
  test(`unsupported checked automatic launch navigates from ${entry} to explicit manual handoff`, async ({
    page,
    context,
  }) => {
    const calls: { command: string; args?: Record<string, unknown> }[] = [];
    let running = false,
      borrowed = false;
    let production = { mode: 'preparation', revision: 'manual-entry', canEnter: true };
    const tool = {
      installed: 'Beta16.2',
      latest: 'Beta16.2',
      launchProtocol: null,
      busy: false,
      message: '',
      packs: [],
    };
    await context.route('**/local/v1/orchestration', (route) =>
      route.fulfill({
        json: {
          tool,
          preset: emptyOrchestrationPreset(),
          ready: false,
          status: {
            control: { mode: 'native', state: 'blocked' },
            connected: false,
            connection: 0,
            context: '',
            map: null,
            pack: null,
            isolated: false,
            held: true,
            request: 'idle',
            execution: 'unconfirmed',
            current: null,
            message: '',
          },
        },
      }),
    );
    await context.route('**/local/v1/production', (route) => route.fulfill({ json: production }));
    await context.route('**/local/v1/demo-test', (route) =>
      route.fulfill({ json: { active: false } }),
    );
    await context.route('**/local/v1/obs', (route) =>
      route.fulfill({ json: { connection: 'connected', findings: [] } }),
    );
    await context.route('**/operator/obs/ensure', (route) => route.fulfill({ json: { ok: true } }));
    await context.route('**/operator/production', (route) => {
      expect(borrowed).toBe(true);
      production = { ...production, mode: 'live' };
      return route.fulfill({ json: production });
    });
    await context.exposeBinding(
      'manualMulnxNative',
      (_source, command: string, args?: Record<string, unknown>) => {
        calls.push({ command, ...(args ? { args } : {}) });
        if (command === 'launch_mulnx' && !args?.automatic) {
          running = true;
          return null;
        }
        if (command === 'cs2_config_status')
          return {
            preferMulnx: true,
            running,
            borrowed,
            pending: false,
            phase: running ? 'running' : 'idle',
            qualityPreset: 'high',
            frameRateLimit: 60,
          };
        if (command === 'gsi_status') return { detected: true, installed: true, conflict: false };
        if (command === 'workspace_exit_status') return { busy: false };
        if (command === 'mulnx_handoff_status')
          return {
            processes: [
              {
                pid: 4212,
                created: '134065746000000000',
                executable: 'D:\\Steam\\CS2\\game\\bin\\win64\\cs2.exe',
                managed: false,
              },
            ],
          };
        if (command === 'attach_external_cs2') {
          expect(running).toBe(true);
          expect(args).toMatchObject({
            pid: 4212,
            created: '134065746000000000',
            expectedRevision: 'manual-entry',
          });
          borrowed = true;
          return false;
        }
        return null;
      },
    );
    await context.addInitScript(() =>
      Object.assign(window, {
        __TAURI_INTERNALS__: {
          invoke: async (command: string, args?: Record<string, unknown>) => {
            const result = await (
              window as typeof window & {
                manualMulnxNative: (
                  command: string,
                  args?: Record<string, unknown>,
                ) => Promise<unknown>;
              }
            ).manualMulnxNative(command, args);
            if (command === 'launch_mulnx' && args?.automatic) throw 'mulnx_manual_launch_required';
            return result;
          },
        },
      }),
    );
    await page.goto(entry);
    await page.getByRole('button', { name: '打开直播工作台', exact: true }).click();
    const route = page.getByRole('link', { name: '打开手动启动与游戏交接', exact: true });
    await expect(route).toHaveAttribute('href', '/settings?tab=camera#mulnx-launch');
    expect(
      calls.some((call) =>
        [
          'attach_external_cs2',
          'start_managed_cs2',
          'present_production',
          'set_cs2_preferences',
        ].includes(call.command),
      ),
    ).toBe(false);
    await route.click();
    const region = page.getByRole('region', { name: 'MulNX 启动与游戏交接' });
    await expect(region).toContainText('在官方启动器完成环境检查后启动');
    await expect(region).not.toContainText('请先更新');
    await page.getByRole('button', { name: '打开本机 MulNX', exact: true }).click();
    expect(borrowed).toBe(false);
    await page.getByRole('button', { name: '检查游戏实例', exact: true }).click();
    await expect(region).toContainText('134065746000000000');
    await expect(region).toContainText('D:\\Steam\\CS2\\game\\bin\\win64\\cs2.exe');
    expect(borrowed).toBe(false);
    await page.getByRole('button', { name: '借用此游戏并进入工作台', exact: true }).click();
    await expect
      .poll(() => calls.filter((call) => call.command === 'present_production').length)
      .toBe(1);
    expect(calls.filter((call) => call.command === 'attach_external_cs2')).toHaveLength(1);
    expect(
      calls.some((call) =>
        ['start_managed_cs2', 'finish_managed_cs2', 'set_cs2_preferences'].includes(call.command),
      ),
    ).toBe(false);
  });
}
