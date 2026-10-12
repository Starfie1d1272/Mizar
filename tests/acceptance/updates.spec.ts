import { expect, test } from './companion-isolation.js';

async function updateFixture(
  page: import('@playwright/test').Page,
  installFailure = '更新未完成，请重试。',
) {
  // API/IPC fixtures prove interaction only; native installation has separate evidence.
  const status = {
    phase: 'available',
    productionRevision: 'preparation-1',
    automatic: false,
    notificationPending: false,
    notificationSafe: false,
    currentVersion: '1.0.0',
    distribution: 'installed',
    error: null as string | null,
    lastResult: null as string | null,
    failureDetails: [] as {
      stage: string;
      stageLabel: string;
      summary: string;
      nextStep: string;
      operationId: string;
    }[],
    downloadedBytes: 0,
    candidate: {
      version: '1.1.0',
      notes: '新增应用内更新，一键升级到最新版本。',
      installer: { bytes: 100 },
    },
    installBlockedReason: null as string | null,
    canResumeAutomatic: false,
  };
  const actions: string[] = [];
  let completeDownload = false;
  let notifyGate: Promise<void> | null = null;
  let statusReads = 0;
  await page.route('**/operator/obs/launch-target', (route) =>
    route.fulfill({ json: { executablePath: 'C:\\OBS\\obs64.exe' } }),
  );
  await page.route('**/local/v1/updates', (route) => {
    statusReads++;
    return route.fulfill({ json: status });
  });
  await page.route('**/operator/updates', async (route) => {
    const body = route.request().postDataJSON() as { action: string; enabled?: boolean };
    actions.push(body.action);
    if (body.action === 'automatic') status.automatic = body.enabled ?? false;
    if (body.action === 'notify') {
      const notification =
        status.notificationPending && status.notificationSafe
          ? { version: status.candidate.version, notes: status.candidate.notes }
          : null;
      const response = { ...status, notification };
      if (notifyGate) await notifyGate;
      await route.fulfill({ json: response });
      return;
    }
    if (body.action === 'dismiss-notification') status.notificationPending = false;
    if (body.action === 'download') {
      status.phase = completeDownload ? 'ready' : 'downloading';
      status.downloadedBytes = completeDownload ? 100 : 40;
    }
    if (body.action === 'cancel') status.phase = 'available';
    if (body.action === 'resume') {
      status.installBlockedReason = null;
      status.canResumeAutomatic = false;
    }
    await route.fulfill({ json: status });
  });
  await page.addInitScript((installFailure) => {
    const commands: string[] = [];
    Object.assign(window, {
      updateCommands: commands,
      __TAURI_INTERNALS__: {
        invoke: <T>(command: string): Promise<T> => {
          if (command === 'read_obs_configuration_context')
            return Promise.resolve({ documentGeneration: '0', message: '' } as T);
          if (command === 'install_update' || command.startsWith('open_update'))
            commands.push(command);
          return command === 'install_update'
            ? Promise.reject(new Error(installFailure))
            : Promise.resolve({} as T);
        },
      },
    });
  }, installFailure);
  return {
    status,
    actions,
    completeDownload: () => {
      completeDownload = true;
    },
    statusReads: () => statusReads,
    pauseNotify: () => {
      let resume!: () => void;
      notifyGate = new Promise<void>((resolve) => {
        resume = resolve;
      });
      return () => {
        notifyGate = null;
        resume();
      };
    },
    commands: () => page.evaluate(() => Reflect.get(window, 'updateCommands') as string[]),
  };
}

test('entering and leaving production during download revokes the previous installation request', async ({
  page,
}) => {
  const { status, commands } = await updateFixture(page);
  await page.goto('/settings?tab=advanced');
  const update = page.getByRole('button', { name: '一键更新', exact: true });
  await update.click();
  await expect(page.getByRole('button', { name: '正在更新…', exact: true })).toBeVisible();
  // Both lifecycle transitions can occur between polls; revision still records the change.
  status.productionRevision = 'preparation-after-live';
  await expect(page.getByRole('button', { name: '稍后', exact: true })).toHaveCount(0);
  status.phase = 'ready';
  status.installBlockedReason = '结束制作后可更新。';
  await expect(update).toBeDisabled();
  status.installBlockedReason = null;
  await expect(update).toBeEnabled();
  expect(await commands()).toEqual([]);
});

test('one update click downloads and installs without a dialog, with manual direction recovery and errors', async ({
  page,
}) => {
  const { status, commands, actions, completeDownload } = await updateFixture(page);
  completeDownload();
  status.installBlockedReason = '结束节目制作后可更新。';
  status.canResumeAutomatic = true;
  await page.goto('/settings?tab=advanced');
  const update = page.getByRole('button', { name: '一键更新', exact: true });
  await update.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByText('更新未完成，请重试。', { exact: true })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(actions).toEqual(['download', 'resume']);
  expect(await commands()).toEqual(['install_update']);
});
