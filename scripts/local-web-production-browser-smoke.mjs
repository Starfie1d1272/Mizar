import { strict as assert } from 'node:assert';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { iterateCaptureFrames, verifyCapture } from '../packages/testkit/dist/index.js';
import { toMatchContext } from '../packages/rivalhub/dist/index.js';
import { buildApp } from '../apps/companion/dist/app.js';
import {
  buildReplayManifestFromCapture,
  normalizeReplayManifest,
  readReplayManifest,
} from '../apps/companion/test/support/real-program-replay.ts';

// Only fixture preparation uses test helpers. HTTP ingress, adapters, runtime,
// projections, WS transport and the browser all execute production builds.
const root = resolve(import.meta.dirname, '..');
const evidenceDir = resolve(root, '.agent-tmp/production-browser-smoke');
const capture = await verifyCapture(resolve(root, 'fixtures/gsi/acceptance/ancient-round-03'));
assert.equal(
  capture.computedFramesSha256,
  '54fbddf82f67d61126ccfb0f1e19c98ff23c94a31e9bfdbfb79038dabd99f7c3',
);
const manifest = await normalizeReplayManifest(
  capture,
  await buildReplayManifestFromCapture(capture, await readReplayManifest()),
);
const context = toMatchContext(manifest);
let receive = { receivedAt: capture.manifest.createdAt, receivedMonotonicMs: 0 };
let sequence = 0;
const app = buildApp({
  webRoot: resolve(root, 'apps/web/dist'),
  gsiToken: 'production-browser-replay',
  gsiSequenceSource: () => sequence,
  clock: { now: () => receive },
  projectionNowMonotonicMs: () => receive.receivedMonotonicMs,
  matchContextBinding: {
    manifest,
    context,
    origin: 'fixture',
    freshness: 'fresh',
    diagnostics: [],
  },
});
let browser;
const errors = [];
const startedAt = new Date().toISOString();
await mkdir(evidenceDir, { recursive: true });
try {
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  assert(address && typeof address !== 'string');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  page.on('pageerror', (error) => errors.push(error.message));
  const navigation = await page.goto(`${baseUrl}/program`);
  assert.equal(navigation.status(), 200);
  const frames = [];
  for await (const frame of iterateCaptureFrames(capture)) frames.push(frame);
  assert.equal(frames.length, 628);
  assert.equal(frames[0].sequence, 587);
  assert.equal(frames.at(-1).sequence, 1214);
  let index = 0;
  const postThrough = async (target) => {
    for (; index < frames.length && frames[index].sequence <= target; index++) {
      const frame = frames[index];
      sequence = frame.sequence;
      receive = { receivedAt: frame.receivedAt, receivedMonotonicMs: frame.elapsedUs / 1000 };
      const response = await globalThis.fetch(`${baseUrl}/gsi`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...frame.payload, auth: { token: 'production-browser-replay' } }),
        signal: globalThis.AbortSignal.timeout(5000),
      });
      assert.equal(response.status, 204);
    }
  };
  // Independent facts from the preserved round, not expectations computed from projections.
  await postThrough(1000);
  await expect(page.locator('[data-gameplay-hud]')).toBeVisible();
  await expect(page.locator('[data-player-card]')).toHaveCount(10);
  await expect(page.locator('.match-header__team-name')).toHaveText(['FURIA', 'G2.Esports']);
  const radar = page.getByLabel('比赛雷达', { exact: true });
  await expect(radar).toHaveAttribute('data-radar-sample-sequence', '1000');
  await expect(radar).toHaveAttribute('data-radar-players', '10');
  await expect(radar).toHaveAttribute('data-radar-artwork', 'ready');
  // Dataset publication alone cannot prove that Canvas actually painted.
  await expect
    .poll(() =>
      radar.evaluate((canvas) => {
        const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
        return pixels.some((value, index) => index % 4 === 3 && value > 0);
      }),
    )
    .toBe(true);
  await postThrough(1158);
  await expect(page.locator('.objective-center')).toHaveAttribute('data-objective-mode', 'planted');
  await expect(page.locator('.focused-player')).toContainText('huNter-');
  await postThrough(1214);
  assert.equal(index, frames.length);
  await expect(page.locator('.match-header__map-score')).toHaveText(['2', '1']);
  await expect(page.locator('[data-objective-mode="planted"]')).toHaveCount(0);
  assert.deepEqual(errors, []);
  await page.screenshot({ path: resolve(evidenceDir, 'program.png') });
  await writeFile(
    resolve(evidenceDir, 'result.json'),
    JSON.stringify(
      {
        status: 'PASS',
        startedAt,
        finishedAt: new Date().toISOString(),
        sourceFramesSha256: capture.computedFramesSha256,
        framesPosted: index,
        firstSequence: 587,
        lastSequence: 1214,
        evidence: 'production Web + Companion HTTP GSI + WS + Chromium; no request interception',
      },
      null,
      2,
    ),
  );
  console.log('LOCAL_WEB_PRODUCTION_BROWSER_SMOKE_PASS');
} catch (error) {
  await writeFile(
    resolve(evidenceDir, 'result.json'),
    JSON.stringify(
      {
        status: 'FAIL',
        startedAt,
        finishedAt: new Date().toISOString(),
        message: error.message,
      },
      null,
      2,
    ),
  );
  throw error;
} finally {
  await browser?.close();
  await app.close();
}
