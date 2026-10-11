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

test('installation recovery read failures stay visible without an operation error after checking', async ({
  page,
}) => {
  const { status, actions } = await updateFixture(page);
  status.phase = 'current';
  status.failureDetails = [
    {
      stage: 'result_load',
      stageLabel: '读取安装恢复记录',
      summary: '操作未完成，原因未知。',
      nextStep:
        '保留当前版本及更新、备份和恢复记录；检查用户资料目录的读写权限与剩余空间，导出诊断。不要删除记录绕过校验。',
      operationId: 'record-read',
    },
  ];
  await page.goto('/settings?tab=advanced');
  const guidance = page.getByText(/不要删除记录绕过校验/);
  await expect(guidance).toBeVisible();
  await expect(page.getByRole('button', { name: '导出诊断包', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '检查更新', exact: true }).click();
  await expect.poll(() => actions).toEqual(['check']);
  await expect(page.getByRole('button', { name: '检查更新', exact: true })).toBeEnabled();
  await expect(guidance).toBeVisible();
  status.failureDetails[0]!.stage = 'result_identity_load';
  await expect.poll(() => status.error).toBeNull();
  await page.reload();
  await expect(guidance).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('update-recovery-read-warning.png') });
});

test('desktop update reminders wait for safe idle, dismiss once and open the existing update settings', async ({
  page,
}) => {
  const { status, actions, commands } = await updateFixture(page);
  status.automatic = true;
  status.notificationPending = true;
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '总览', exact: true })).toBeVisible();
  const dialog = page.getByRole('dialog', { name: '发现新版 v1.1.0' });
  await expect(dialog).not.toBeVisible();
  expect(actions).toEqual([]);
  status.notificationSafe = true;
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(status.candidate.notes, { exact: true })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('update-notification.png') });
  await dialog.getByRole('button', { name: '稍后', exact: true }).focus();
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect.poll(() => status.notificationPending).toBe(false);
  await page.reload();
  await expect(page.getByRole('heading', { name: '总览', exact: true })).toBeVisible();
  await expect(dialog).not.toBeVisible();
  expect(actions).toEqual(['notify', 'dismiss-notification']);
  status.candidate.version = '1.2.0';
  status.notificationPending = true;
  const newer = page.getByRole('dialog', { name: '发现新版 v1.2.0' });
  await expect(newer).toBeVisible();
  await newer.getByRole('button', { name: '查看更新', exact: true }).click();
  await expect(page).toHaveURL(/\/settings\?tab=advanced$/);
  await expect(page.getByRole('heading', { name: '应用更新', exact: true })).toBeVisible();
  await expect
    .poll(() => actions)
    .toEqual(['notify', 'dismiss-notification', 'notify', 'dismiss-notification']);
  expect(await commands()).toEqual([]);
});

for (const interruption of ['poll', 'input', 'focus', 'production'] as const) {
  test(`desktop reminder survives ${interruption} while its read is pending`, async ({ page }) => {
    const { status, actions, statusReads, pauseNotify } = await updateFixture(page);
    status.automatic = true;
    status.notificationPending = true;
    status.notificationSafe = true;
    const resume = pauseNotify();
    await page.addInitScript(() => {
      Object.assign(window, { reminderFocused: true });
      document.hasFocus = () => Reflect.get(window, 'reminderFocused') === true;
    });
    await page.goto('/');
    await expect.poll(() => actions.length).toBe(1);
    const initialReads = statusReads();
    if (interruption === 'input') {
      await page.evaluate(() => {
        const input = document.createElement('input');
        input.id = 'reminder-input';
        document.body.append(input);
      });
      await page.locator('#reminder-input').fill('正在输入');
    } else if (interruption === 'focus') {
      await page.evaluate(() => Reflect.set(window, 'reminderFocused', false));
    } else if (interruption === 'production') {
      status.notificationSafe = false;
    }
    // Ensure a status poll actually rerenders while the first response is pending.
    await expect.poll(statusReads, { timeout: 10000 }).toBeGreaterThan(initialReads);
    const response = page.waitForResponse(
      (response) =>
        response.url().endsWith('/operator/updates') &&
        (response.request().postDataJSON() as { action?: string } | null)?.action === 'notify',
    );
    resume();
    await response;
    const dialog = page.getByRole('dialog', { name: '发现新版 v1.1.0' });
    if (interruption !== 'poll') {
      const readsAfterResponse = statusReads();
      await expect.poll(statusReads, { timeout: 10000 }).toBeGreaterThan(readsAfterResponse);
      await expect(dialog).not.toBeVisible();
      expect(status.notificationPending).toBe(true);
      expect(actions).not.toContain('dismiss-notification');
      if (interruption === 'input')
        await page
          .locator('#reminder-input')
          .evaluate((input) => (input as HTMLInputElement).blur());
      if (interruption === 'focus')
        await page.evaluate(() => Reflect.set(window, 'reminderFocused', true));
      status.notificationSafe = true;
    }
    await expect(dialog).toBeVisible({ timeout: 10000 });
    expect(status.notificationPending).toBe(true);
    await dialog.getByRole('button', { name: '稍后', exact: true }).click();
    await expect.poll(() => status.notificationPending).toBe(false);
    expect(actions.filter((action) => action === 'dismiss-notification')).toHaveLength(1);
  });
}

test('a displayed reminder pauses for production and resumes until explicitly closed', async ({
  page,
}) => {
  const { status, actions } = await updateFixture(page);
  status.automatic = true;
  status.notificationPending = true;
  status.notificationSafe = true;
  await page.goto('/');
  const dialog = page.getByRole('dialog', { name: '发现新版 v1.1.0' });
  await expect(dialog).toBeVisible();
  status.notificationSafe = false;
  await expect(dialog).not.toBeVisible();
  expect(status.notificationPending).toBe(true);
  expect(actions).toEqual(['notify']);
  status.notificationSafe = true;
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: '稍后', exact: true }).click();
  await expect.poll(() => status.notificationPending).toBe(false);
  expect(actions).toEqual(['notify', 'dismiss-notification']);
});

test('update cancellation and postponement preserve the download choice without installing later', async ({
  page,
}) => {
  const { status, commands } = await updateFixture(page);
  await page.goto('/settings?tab=advanced');
  await expect(
    page.getByText('新增应用内更新，一键升级到最新版本。', { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('checkbox', { name: '自动检查更新' })).toBeHidden();
  await page.getByText('更新设置', { exact: true }).click();
  const automatic = page.getByRole('checkbox', { name: '自动检查更新' });
  await expect(automatic).not.toBeChecked();
  await automatic.click();
  await expect(automatic).toBeChecked();
  const update = page.getByRole('button', { name: '一键更新', exact: true });
  await update.click();
  await expect(page.getByRole('progressbar', { name: '更新下载进度' })).toHaveAttribute(
    'value',
    '40',
  );
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await expect(update).toBeEnabled();
  await update.click();
  await page.getByRole('button', { name: '稍后', exact: true }).click();
  status.phase = 'ready';
  await expect(update).toBeEnabled();
  expect(await commands()).toEqual([]);
});

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

test('idle update reaches installation without starting or connecting OBS', async ({
  page,
}, testInfo) => {
  // Actual rendered flow; status/IPC fixtures do not prove Windows installation.
  const { actions, commands, completeDownload } = await updateFixture(page);
  completeDownload();
  let obsLaunches = 0;
  await page.route('**/local/v1/obs', (route) =>
    route.fulfill({
      json: { connection: 'unavailable', streaming: false, recording: false, findings: [] },
    }),
  );
  await page.route('**/operator/obs/launch-target', (route) => {
    obsLaunches++;
    return route.fulfill({ json: { executablePath: null } });
  });
  await page.goto('/settings?tab=advanced');
  await page.getByRole('button', { name: '检查更新', exact: true }).click();
  await expect(page.getByRole('button', { name: '一键更新', exact: true })).toBeEnabled();
  await page.screenshot({ path: testInfo.outputPath('update-without-obs-ready.png') });
  await page.getByRole('button', { name: '一键更新', exact: true }).click();
  await expect(page.getByText('更新未完成，请重试。', { exact: true })).toBeVisible();
  expect(actions).toEqual(['check', 'download']);
  expect(await commands()).toEqual(['install_update']);
  expect(obsLaunches).toBe(0);
  await page.screenshot({ path: testInfo.outputPath('update-without-obs.png') });
});

test('unverified updates and portable builds offer manual download and render notes as text', async ({
  page,
}) => {
  const { status } = await updateFixture(page);
  status.phase = 'error';
  status.error = 'update_provenance_failed';
  status.candidate.notes = '<script>untrusted()</script>';
  await page.goto('/settings?tab=advanced');
  await expect(
    page.getByText('更新来源认证未通过。请保留现有版本，导出诊断并从正式发布页核对安装包。'),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'GitHub 下载' })).toBeVisible();
  const diagnostic = {
    schema: 'mizar-support-bundle/1',
    logs: [
      {
        localDiagnostic: {
          message: 'independent original transport failure',
          cause: { code: 'ECONNRESET' },
        },
      },
    ],
  };
  await page.route('**/debug/support-bundle', (route) => route.fulfill({ json: diagnostic }));
  await page.evaluate(() =>
    Object.defineProperty(navigator, 'clipboard', {
      value: {
        writeText: async (text: string) => {
          Reflect.set(window, 'copiedDiagnostic', text);
          await Promise.resolve();
        },
      },
      configurable: true,
    }),
  );
  await page.getByRole('button', { name: '复制诊断信息' }).click();
  await expect(page.getByText('诊断信息已复制，包含脱敏原因与相关输出。')).toBeVisible();
  expect(await page.evaluate(() => Reflect.get(window, 'copiedDiagnostic') as string)).toBe(
    JSON.stringify(diagnostic),
  );

  await expect(page.getByText('<script>untrusted()</script>', { exact: true })).toBeVisible();
  status.phase = 'manual';
  status.error = null;
  status.distribution = 'portable';
  await page.reload();
  await expect(page.getByRole('button', { name: '下载新版', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '一键更新', exact: true })).toHaveCount(0);
});

test('installation recheck reason forwarded by native IPC stays actionable in update settings', async ({
  page,
}) => {
  const message =
    'GitHub API 访问额度已耗尽（HTTP 403）。 请等待 GitHub API 额度恢复后重新检查，或从正式发布页获取完整包；保留当前版本。';
  const { commands, completeDownload } = await updateFixture(page, message);
  completeDownload();
  await page.goto('/settings?tab=advanced');
  await page.getByRole('button', { name: '一键更新', exact: true }).click();
  await expect(page.getByText(message, { exact: true })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('update-recheck-quota.png') });
  await expect(page.getByRole('button', { name: '导出诊断包', exact: true })).toBeVisible();
  expect(await commands()).toEqual(['install_update']);
});

test('recovery action accurately opens the directory and explains the existing manual recovery', async ({
  page,
}) => {
  const { status, commands } = await updateFixture(page);
  status.lastResult = 'recovery-required';
  await page.goto('/settings?tab=advanced');
  await expect(page.getByText(/对应 install-\* 安装记录目录运行 Restore-Mizar.cmd/)).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('update-recovery-directory.png') });
  await page.getByRole('button', { name: '打开恢复目录', exact: true }).click();
  expect(await commands()).toEqual(['open_update_recovery']);
});
