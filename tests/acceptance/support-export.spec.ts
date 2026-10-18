import { randomBytes } from 'node:crypto';
import { SessionJournal } from '../../apps/companion/src/support/session-journal.js';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { buildApp } from '../../apps/companion/src/app.js';
import { expect, test } from './companion-isolation.js';

test('normal UI exports retained operations and producer/renderer performance through real local transport', async ({
  page,
  context,
}, testInfo) => {
  const logs = await mkdtemp(join(tmpdir(), 'mizar-browser-performance-'));
  const journal = new SessionJournal(logs);
  journal.record('synthetic_large_record', { text: randomBytes(384 * 1024).toString('hex') });
  const app = buildApp({
    supportJournal: journal,
    supportLogsDirectory: logs,
    gsiToken: 'synthetic-performance-gsi',
    productRuntime: {
      gitSha: 'a'.repeat(40),
      artifactSha256: 'b'.repeat(64),
      instanceId: 'private-instance',
      controlToken: 'private-token',
      stop() {},
    },
  });
  try {
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    let supportRequests = 0;
    await context.route(/\/debug\/(support-bundle|control-event)$/, async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/debug/support-bundle') supportRequests++;
      const response = await route.fetch({ url: `${address}${path}` });
      await route.fulfill({ response });
    });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto('/debug');
    await expect(page.getByRole('heading', { name: '运行诊断', exact: true })).toBeVisible();
    const websocketHost = new URL(address).host;
    await page.routeWebSocket(`ws://${websocketHost}/local/v1/program`, (route) => {
      route.connectToServer();
    });
    await page.evaluate(async (host) => {
      const path = '/src/realtime/local-channel-client.ts';
      const { createLocalChannelClient } = (await import(path)) as {
        createLocalChannelClient: (
          channel: 'program',
          options: { location: { protocol: string; host: string } },
        ) => {
          subscribe: (listener: () => void) => () => void;
          getSnapshot: () => {
            state: string;
            error: string | null;
            current: { cursor: { programReceiveSequence: number | null } } | null;
          };
          start: () => void;
        };
      };
      const client = createLocalChannelClient('program', { location: { protocol: 'http:', host } });
      client.subscribe(() => {
        (window as Window & { diagnosticProbeSequence?: number | null }).diagnosticProbeSequence =
          client.getSnapshot().current?.cursor.programReceiveSequence ?? null;
        (window as Window & { diagnosticProbeStatus?: unknown }).diagnosticProbeStatus =
          client.getSnapshot();
      });
      client.start();
    }, websocketHost);
    const input = await app.inject({
      method: 'POST',
      url: '/gsi',
      payload: {
        auth: { token: 'synthetic-performance-gsi' },
        map: {
          name: 'de_nuke',
          phase: 'live',
          round: 0,
          team_ct: { score: 0 },
          team_t: { score: 0 },
        },
      },
    });
    expect(input.statusCode).toBe(204);
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as Window & { diagnosticProbeStatus?: { state: string } }).diagnosticProbeStatus
              ?.state,
        ),
      )
      .toBe('live');
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as Window & { diagnosticProbeSequence?: number | null })
              .diagnosticProbeSequence ?? -1,
        ),
      )
      .toBeGreaterThanOrEqual(0);
    // A controlled own-document stall must survive aggregation and real export.
    await page.evaluate(async () => {
      await new Promise(requestAnimationFrame);
      const until = performance.now() + 120;
      while (performance.now() < until) {
        /* synthetic main-thread work */
      }
      await new Promise(requestAnimationFrame);
    });
    const downloading = page.waitForEvent('download');
    await page.getByRole('button', { name: '导出诊断包', exact: true }).click();
    const download = await downloading;
    const bytes = await readFile(await download.path());
    const result = JSON.parse(bytes.toString('utf8')) as {
      schema: string;
      manifest: unknown;
      fullLogs: { files: { name: string; status: string; volumes: { gzipBase64: string }[] }[] };
      snapshot: { runtime: { freshness: string }; nativeObs: { collectionStatus: string } };
    };
    expect(result.schema).toBe('mizar-support-bundle/1');
    expect(result.manifest).toMatchObject({
      gitSha: 'a'.repeat(40),
      artifactSha256: 'b'.repeat(64),
    });
    expect(result.snapshot.runtime.freshness).toBe('fresh');
    const events = result.fullLogs.files
      .filter((file) => file.name.startsWith('session.ndjson') && file.status === 'read')
      .flatMap((file) =>
        Buffer.concat(
          file.volumes.map((volume) => gunzipSync(Buffer.from(volume.gzipBase64, 'base64'))),
        )
          .toString('utf8')
          .trim()
          .split('\n')
          .map(
            (line) =>
              JSON.parse(line) as {
                stage: string;
                evidence: {
                  operation?: string;
                  processing?: { count: number };
                  input?: { normalized?: { sequence: number } };
                  evidence?: {
                    frames: { maxGapMs: number };
                    channels: {
                      channel: string;
                      accepted: number;
                      cursor: { programReceiveSequence: number };
                    }[];
                  };
                };
              },
          ),
      );
    const runtime = events.find((event) => event.stage === 'runtime_performance_window')!;
    expect(runtime.evidence.processing!.count).toBeGreaterThan(0);
    expect(runtime.evidence.input!.normalized!.sequence).toBeGreaterThanOrEqual(0);
    const renderer = events.find((event) => event.evidence.operation === 'browser_performance')!;
    expect(renderer.evidence.evidence!.frames.maxGapMs).toBeGreaterThan(80);
    expect(renderer.evidence.evidence!.channels).toContainEqual(
      expect.objectContaining({
        channel: 'program',
        accepted: expect.any(Number),
        cursor: expect.objectContaining({
          programReceiveSequence: runtime.evidence.input!.normalized!.sequence,
        }),
      }),
    );
    if (process.platform === 'win32')
      expect(['available', 'failed', 'timeout']).toContain(
        result.snapshot.nativeObs.collectionStatus,
      );
    else expect(result.snapshot.nativeObs.collectionStatus).toBe('unsupported');
    await testInfo.attach('support-export-real-ui', {
      body: await page.screenshot(),
      contentType: 'image/png',
    });
    expect(bytes.byteLength).toBeGreaterThan(256 * 1024);
    expect(bytes.byteLength).toBeLessThanOrEqual(256 * 1024 * 1024);
    expect(bytes.toString('utf8')).not.toContain('private-');
    await page.route('**/local/v1/updates', (route) =>
      route.fulfill({
        json: {
          phase: 'error',
          productionRevision: 'preparation-1',
          automatic: false,
          currentVersion: '1.4.0',
          distribution: 'installed',
          error: 'update_network_failed',
          candidate: null,
          downloadedBytes: 0,
          failureDetails: [
            {
              stage: 'download',
              summary: '更新网络请求失败。',
              nextStep: '网络恢复后重试。',
              operationId: 'synthetic-update',
            },
          ],
        },
      }),
    );
    await page.goto('/settings?tab=advanced');
    // Install the clipboard probe after navigation, without invoking the OS clipboard.
    await page.evaluate(() => {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: (text: string) => {
            (window as Window & { copiedUpdateSummary?: string }).copiedUpdateSummary = text;
            return Promise.resolve();
          },
        },
      });
    });
    const requestsBeforeCopy = supportRequests;
    await page.getByRole('button', { name: '复制更新摘要', exact: true }).click();
    await expect(
      page.getByText('更新摘要已复制。完整操作记录请导出诊断包后私下交付维护者。'),
    ).toBeVisible();
    const summary = await page.evaluate(
      () => (window as Window & { copiedUpdateSummary?: string }).copiedUpdateSummary!,
    );
    expect(JSON.parse(summary)).toMatchObject({
      schema: 'mizar-update-summary/1',
      error: 'update_network_failed',
    });
    expect(summary).not.toContain('synthetic_large_record');
    expect(summary).not.toContain('fullLogs');
    expect(supportRequests).toBe(requestsBeforeCopy);
    const opening = page.waitForEvent('popup');
    await page.getByRole('alert').getByRole('button', { name: '导出诊断包', exact: true }).click();
    const diagnostics = await opening;
    await expect(diagnostics.getByRole('heading', { name: '运行诊断', exact: true })).toBeVisible();
    const fullDownload = diagnostics.waitForEvent('download');
    await diagnostics.getByRole('button', { name: '导出诊断包', exact: true }).click();
    const fullBytes = await readFile(await (await fullDownload).path());
    expect(fullBytes.byteLength).toBeGreaterThan(256 * 1024);
    expect(JSON.parse(fullBytes.toString('utf8'))).toMatchObject({
      schema: 'mizar-support-bundle/1',
      fullLogs: { status: 'available' },
    });
    await testInfo.attach('update-summary-large-export-evidence', {
      contentType: 'application/json',
      body: JSON.stringify({
        firstExportBytes: bytes.byteLength,
        updateExportBytes: fullBytes.byteLength,
        copiedSummaryBytes: Buffer.byteLength(summary),
        fullExportRequestsDuringCopy: supportRequests - requestsBeforeCopy - 1,
        source: 'real production export of synthetic retained events; no private user records',
      }),
    });
    await diagnostics.close();
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    await rm(logs, { recursive: true, force: true });
  }
});
