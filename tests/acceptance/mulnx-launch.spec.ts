import { test, expect } from './companion-isolation.js';
import { emptyOrchestrationPreset } from '../../packages/protocol/src/orchestration.js';

// Native calls are browser contract doubles; no real launcher, CS2 or OBS is used.
for (const entry of ['/', '/settings?tab=gsi']) {
  test(`unavailable automatic launch reports the failure from ${entry} without manual fallback`, async ({
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
            if (command === 'launch_mulnx' && args?.automatic) {
              // eslint-disable-next-line @typescript-eslint/only-throw-error -- Emulate the actual Tauri Result<T, String> rejection.
              throw 'MulNX 启动接口不可用，请检查更新或选择标准启动；请关闭启动器后重试。';
            }
            return result;
          },
        },
      }),
    );
    await page.goto(entry);
    await page.getByRole('button', { name: '打开直播工作台', exact: true }).click();
    await expect(
      page.getByText('MulNX 启动接口不可用，请检查更新或选择标准启动；请关闭启动器后重试。'),
    ).toBeVisible();
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
    expect(calls.filter((call) => call.command === 'launch_mulnx')).toHaveLength(1);
    expect(
      calls.some((call) => ['attach_external_cs2', 'present_production'].includes(call.command)),
    ).toBe(false);
  });
}
