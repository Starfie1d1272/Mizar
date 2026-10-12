import { expect, test } from './companion-isolation.js';
import { randomUUID } from 'node:crypto';
import type { ObsOutputCommand, ObsOutputsStatus } from '../../packages/protocol/src/obs.js';

test('OBS output controls confirm actual state, protect stop, and reflect external changes', async ({
  page,
}) => {
  let outputs: ObsOutputsStatus = {
    stream: { active: false, phase: 'idle', pending: null, revision: randomUUID() },
    record: { active: true, phase: 'paused', pending: null, revision: randomUUID() },
  };
  let online = true;
  const calls: ObsOutputCommand[] = [];
  let release!: () => void;
  await page.route('**/local/v1/obs/outputs', (route) =>
    route.fulfill({ status: online ? 200 : 503, json: outputs }),
  );
  await page.route('**/operator/obs/output', async (route) => {
    const command = route.request().postDataJSON() as ObsOutputCommand;
    calls.push(command);
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    outputs = {
      ...outputs,
      [command.output]: {
        active: command.action === 'start',
        phase: command.action === 'start' ? 'active' : 'idle',
        pending: null,
        revision: randomUUID(),
      },
    };
    await route.fulfill({ json: { ok: true, outputs } });
  });
  await page.goto('/workspace/dock');
  await page.getByRole('button', { name: '开始直播', exact: true }).click();
  await expect(page.getByRole('button', { name: '开始直播中…' })).toBeDisabled();
  await expect.poll(() => calls.length).toBe(1);
  release();
  await page.getByRole('button', { name: '停止直播', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('停止 OBS 直播');
  await expect(page.getByRole('button', { name: '取消', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  expect(calls).toHaveLength(1);
  await page.getByRole('button', { name: '停止直播', exact: true }).click();
  await page.getByRole('button', { name: '确认停止', exact: true }).click();
  await expect.poll(() => calls.length).toBe(2);
  expect(calls[1]).toMatchObject({ output: 'stream', action: 'stop' });
  release();
  await expect(page.getByRole('button', { name: '开始直播', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '暂停 · 停止', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('停止 OBS 录像');
  outputs = {
    ...outputs,
    record: { active: false, phase: 'idle', pending: null, revision: randomUUID() },
  };
  await expect(page.getByRole('button', { name: '确认停止', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.getByRole('button', { name: '开始录像', exact: true })).toBeEnabled();
  online = false;
  await expect(page.getByRole('button', { name: '直播待确认', exact: true })).toBeDisabled();
  online = true;
  outputs = {
    ...outputs,
    stream: { active: true, phase: 'reconnecting', pending: null, revision: randomUUID() },
  };
  await expect(page.getByRole('button', { name: '重连 · 停止', exact: true })).toBeEnabled();
  expect(calls).toHaveLength(2);
});

test('workspace exit outcome survives a closed dock and failure allows a single retry with diagnostics', async ({
  page,
  context,
}, testInfo) => {
  // Shared IPC fixture; this proves UI visibility, not native CS2 cleanup.
  let outcome = { busy: false, stage: '', message: null as string | null };
  let finishes = 0;
  let release!: () => void;
  const calls: { command: string; args?: unknown }[] = [];
  await context.exposeBinding('exitNative', async (_source, command: string, args?: unknown) => {
    if (command === 'workspace_exit_status') return outcome;
    if (command === 'cs2_config_status') return { pending: true, running: true, phase: 'running' };
    calls.push({ command, args });
    if (command === 'finish_workspace') {
      finishes++;
      outcome = { busy: true, stage: 'restoration', message: null };
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      outcome =
        finishes === 1
          ? {
              busy: false,
              stage: 'restoration',
              message: 'CS2 尚未退出，请手动退出游戏后重试恢复。',
            }
          : { busy: false, stage: '', message: null };
      if (outcome.message) throw new Error(outcome.message);
    }
    return null;
  });
  await context.addInitScript(() =>
    Object.assign(window, {
      __TAURI_INTERNALS__: {
        invoke: (command: string, args?: unknown) =>
          (
            window as unknown as {
              exitNative: (command: string, args?: unknown) => Promise<unknown>;
            }
          ).exitNative(command, args),
      },
    }),
  );
  await context.route('**/local/v1/obs', (route) =>
    route.fulfill({
      json: { connection: 'connected', findings: [], streaming: false, recording: false },
    }),
  );
  await context.route('**/operator/obs/*', (route) =>
    route.fulfill({ json: { alreadyRunning: true } }),
  );
  await context.route('**/local/v1/production', (route) =>
    route.fulfill({ json: { mode: 'live', revision: 'exit-1', canEnter: true } }),
  );
  await page.goto('/workspace/dock');
  await page.getByRole('button', { name: '退出工作台', exact: true }).click();
  await expect.poll(() => finishes).toBe(1);
  const recovery = await context.newPage();
  await recovery.goto('/');
  const result = recovery.getByLabel('工作台退出结果');
  await expect(result).toContainText('关闭游戏与恢复设置');
  await expect(
    recovery.getByRole('button', { name: '打开直播工作台', exact: true }),
  ).toBeDisabled();
  await expect(result.getByRole('button', { name: '正在退出…' })).toBeDisabled();
  await result.getByRole('button', { name: '运行诊断', exact: true }).click();
  expect(calls).toContainEqual({ command: 'open_tool', args: { tool: 'diagnostics' } });
  await page.close();
  release();
  await expect(result).toContainText('CS2 尚未退出，请手动退出游戏后重试恢复。');
  await expect(result.getByRole('button', { name: '重试退出工作台' })).toBeEnabled();
  await expect(
    recovery.getByText('CS2 尚未退出，请手动退出游戏后重试恢复。', { exact: true }),
  ).toHaveCount(1);
  const screenshot = testInfo.outputPath('workspace-exit-recovery.png');
  await recovery.screenshot({ path: screenshot, fullPage: true });
  await testInfo.attach('隐藏后的退出失败反馈（浏览器 IPC 模拟）', {
    path: screenshot,
    contentType: 'image/png',
  });
  await result.getByRole('button', { name: '重试退出工作台' }).click();
  await expect.poll(() => finishes).toBe(2);
  await expect(result.getByRole('button', { name: '正在退出…' })).toBeDisabled();
  expect(finishes).toBe(2);
  release();
  await expect(result).toHaveCount(0);
});
