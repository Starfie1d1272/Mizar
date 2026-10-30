import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { writeFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import { audioModeRig } from './audio-mode-test-rig.js';

const webDir = join(process.cwd(), 'apps/web');
const requireWeb = createRequire(join(webDir, 'package.json'));
const { createServer } = await import(requireWeb.resolve('vite'));
const react = (await import(requireWeb.resolve('@vitejs/plugin-react'))).default;
const prefix = `audio-test-${randomUUID()}`;
const htmlPath = join(webDir, `${prefix}.html`);
const entryPath = join(webDir, `${prefix}.tsx`);
const rig = await audioModeRig();
let vite: Awaited<ReturnType<typeof createServer>> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let htmlCreated = false;
let entryCreated = false;
try {
  await writeFile(
    htmlPath,
    `<div id="root"></div><script type="module" src="/${prefix}.tsx"></script>`,
    { flag: 'wx' },
  );
  htmlCreated = true;
  await writeFile(
    entryPath,
    "import React from 'react'; import {createRoot} from 'react-dom/client'; import {ObsAudioRouting} from './src/preparation/ObsAudioRouting'; createRoot(document.getElementById('root')!).render(<ObsAudioRouting/>);",
    { flag: 'wx' },
  );
  entryCreated = true;
  const api = await rig.listen();
  vite = await createServer({
    root: webDir,
    configFile: false,
    plugins: [react()],
    logLevel: 'error',
    server: { host: '127.0.0.1', port: 0, proxy: { '/local': api, '/operator': api } },
  });
  await vite.listen();
  const address = vite.httpServer!.address();
  if (!address || typeof address === 'string') throw new Error('vite address unavailable');
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${address.port}/${prefix}.html`);
  await page.getByText('当前模式：未确认', { exact: false }).waitFor();
  await page.getByRole('button', { name: '切换桌面混音', exact: true }).click();
  await page.getByText('已切换桌面混音。请录制试听。').waitFor();
  await page.getByRole('button', { name: '切回独立分路', exact: true }).click();
  await page.getByText('已切换独立分路。请录制试听。').waitFor();
  for (const items of rig.scenes.values()) {
    assert.equal(items.find((item) => item.sourceUuid === 'desktop')?.sceneItemEnabled, false);
    assert.equal(items.find((item) => item.sourceUuid === 'game')?.sceneItemEnabled, true);
    assert.equal(items.find((item) => item.sourceUuid === 'ts')?.sceneItemEnabled, true);
  }
  assert.deepEqual(rig.violations, []);
  assert.equal(rig.monitor(), 'OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT');
  await page.getByRole('button', { name: '切换桌面混音', exact: true }).click();
  await page.getByText('已切换桌面混音。请录制试听。').waitFor();
  rig.failIndependent();
  await page.getByRole('button', { name: '切回独立分路', exact: true }).click();
  await page.locator('[role="alert"]').waitFor();
  await rig.adapter.recoverAudioMode(rig.music as never);
  for (const items of rig.scenes.values()) {
    assert.equal(items.find((item) => item.sourceUuid === 'desktop')?.sceneItemEnabled, true);
    assert.equal(items.find((item) => item.sourceUuid === 'game')?.sceneItemEnabled, false);
    assert.equal(items.find((item) => item.sourceUuid === 'ts')?.sceneItemEnabled, false);
  }
  assert.deepEqual(rig.violations, []);
  assert.deepEqual(errors, []);
  console.log(
    'Chromium → Vite proxy → Fastify routes → simulated OBS: round trip and failure recovery passed',
  );
} finally {
  await browser?.close();
  await vite?.close();
  await rig.close();
  if (htmlCreated) await rm(htmlPath, { force: true });
  if (entryCreated) await rm(entryPath, { force: true });
}
