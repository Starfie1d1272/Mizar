import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDisabledRecorder } from '../src/telemetry/capture-recorder.js';
import { buildApp } from '../src/app.js';
import { createCstvSourceManager } from '../src/telemetry/cstv-source-manager.js';
import { startObserverProcess } from '../src/telemetry/observer-process.js';
const driver = fileURLToPath(new URL('./fixtures/observer-child.mjs', import.meta.url));
const outputs: string[] = [];
afterEach(() => {
  for (const path of outputs.splice(0)) rmSync(path, { recursive: true, force: true });
});
const options = {
  role: 'lookahead' as const,
  python: process.execPath,
  driver,
  native: driver,
  steamApi: driver,
  node: process.execPath,
  parserWorker: driver,
  get outputDirectory() {
    const path = join(tmpdir(), 'mizar-observer-' + randomUUID());
    outputs.push(path);
    return path;
  },
  hostVersion: 14191,
  endpoint: '127.0.0.1:27020',
  password: 'synthetic-only',
};
describe('explicit observer process composition', () => {
  it('joins the owned child through actual Companion shutdown without late delivery', async () => {
    const processOwner = startObserverProcess(options);
    const app = buildApp({
      logger: false,
      cstvSources: {
        program: createCstvSourceManager({ role: 'program' }),
        lookahead: processOwner.source,
      },
    });
    try {
      await app.ready();
      await expect.poll(() => processOwner.manager.getRecentGameEvents().length).toBe(1);
      expect(processOwner.manager.getHealth().state).toBe('live');
      expect(processOwner.manager.getRecentGameEvents()[0]?.cursor.role).toBe('lookahead');
      await app.close();
      expect(await processOwner.closed).toMatchObject({ cancelled: true, failed: false, code: 2 });
      expect(processOwner.source.getHealth().state).toBe('stopped');
      expect(processOwner.source.getSnapshot()).toEqual(processOwner.manager.getSnapshot());
    } finally {
      await app.close();
      await processOwner.stop();
    }
  });
  it('surfaces child failure without retaining input or stderr', async () => {
    const processOwner = startObserverProcess({ ...options, endpoint: '127.0.0.2:27020' });
    try {
      const result = await processOwner.closed;
      expect(result.failed).toBe(true);
      expect(result.code).toBe(7);
      expect(result.terminal).toMatchObject({
        report: 'received',
        reason: 'native-start-failed',
        nativeBootCode: 2,
        steamInitResult: 1,
        finalizationFailures: ['close-session'],
      });
      expect(JSON.stringify(result)).not.toContain(options.endpoint);
      expect(JSON.stringify(result)).not.toContain(options.password);
      expect(processOwner.manager.getHealth().state).toBe('stopped');
    } finally {
      await processOwner.stop();
    }
  });
  it.each(['127.0.0.3:27020', '127.0.0.4:27020'])(
    'fails closed without readiness for %s',
    async (endpoint) => {
      const processOwner = startObserverProcess({ ...options, endpoint });
      try {
        const result = await processOwner.closed;
        expect(result).toMatchObject({ failed: true, ready: false });
        if (endpoint === '127.0.0.4:27020') expect(result.terminal.report).toBe('over-budget');
      } finally {
        expect(await processOwner.stop()).toEqual({ exited: true });
      }
    },
  );
  it('reports cleanup failure after the actual app finishes its remaining finalizers', async () => {
    const owner = startObserverProcess({ ...options, endpoint: '127.0.0.5:27020' });
    const recorder = createDisabledRecorder('recorder_not_configured');
    const finalized = vi.spyOn(recorder, 'finalize');
    const app = buildApp({
      logger: false,
      recorder,
      cstvSources: {
        program: createCstvSourceManager({ role: 'program' }),
        lookahead: owner.source,
      },
    });
    try {
      await app.ready();
      await expect.poll(() => owner.manager.getHealth().state).toBe('live');
      await expect(app.close()).rejects.toThrow('Companion source or consumer shutdown failed');
      expect(finalized).toHaveBeenCalledOnce();
      expect(await owner.closed).toMatchObject({
        cancelled: true,
        failed: true,
        terminal: { report: 'received', finalizationFailures: ['close-session'] },
      });
    } finally {
      await owner.stop();
    }
  });
  it('bounds startup readiness without claiming a live source', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const processOwner = startObserverProcess(options);
    try {
      vi.advanceTimersByTime(30_000);
      await processOwner.stop();
      expect(await processOwner.closed).toMatchObject({
        cancelled: true,
        ready: false,
        startupTimedOut: true,
        attemptCount: 1,
      });
    } finally {
      vi.useRealTimers();
      await processOwner.stop();
    }
  });
  it('accepts numeric host updates without imposing a session duration', async () => {
    const temporary = mkdtempSync(join(tmpdir(), 'mizar-observer-contract-'));
    const child = startObserverProcess({
      ...options,
      hostVersion: 14193,
      endpoint: '127.0.0.10:27020',
      outputDirectory: join(temporary, 'run'),
    });
    try {
      expect(await child.closed).toMatchObject({
        code: 0,
        failed: false,
        terminal: {
          report: 'received',
          drainCompleted: true,
          cleanupCompleted: true,
        },
      });
    } finally {
      await child.stop();
      rmSync(temporary, { recursive: true, force: true });
    }
  });
  it('rejects unbounded or unsupported connection data before launch', () => {
    expect(() => startObserverProcess({ ...options, password: 'x'.repeat(96) })).toThrow(
      'Invalid observer launch configuration',
    );
    expect(() => startObserverProcess({ ...options, endpoint: 'example.com:27020' })).toThrow();
    expect(() => startObserverProcess({ ...options, hostVersion: 0 })).toThrow();
  });
});

it.each([
  ['127.0.0.11:27020', 'output-directory', 'missing', 'output-directory-unavailable'],
  ['127.0.0.12:27020', 'configuration', 'missing', 'configuration-boundary'],
  ['127.0.0.13:27020', 'node-probe', 'missing', 'node-runtime-probe-failed'],
  ['127.0.0.14:27020', 'eof', 'missing', undefined],
  ['127.0.0.15:27020', 'eof', 'invalid', undefined],
  ['127.0.0.16:27020', 'eof', 'invalid', undefined],
  ['127.0.0.17:27020', 'session', 'received', 'unclassified'],
  ['127.0.0.19:27020', 'native-boot', 'received', 'native-start-failed'],
  ['127.0.0.21:27020', 'native-boot', 'received', 'native-start-failed'],
  ['127.0.0.22:27020', 'native-boot', 'received', 'native-start-failed'],
  ['127.0.0.23:27020', 'parser-initialization', 'received', 'ordered-parser-exited'],
  ['127.0.0.24:27020', 'native-boot', 'received', 'native-start-failed'],
  ['127.0.0.18:27020', 'parser-initialization', 'received', 'ordered-parser-exited'],
])(
  'retains bounded pre-report and terminal evidence for %s',
  async (endpoint, stage, report, reason) => {
    const owner = startObserverProcess({ ...options, endpoint });
    try {
      const result = await owner.closed;
      expect(result).toMatchObject({ failed: true, attemptCount: 1 });
      expect(result.terminal).toMatchObject({
        stage,
        report,
        ready: false,
        attemptCount: 1,
        code: 1,
        signal: null,
      });
      expect(result.terminal.reason).toBe(reason);
      expect(result.attempts).toHaveLength(1);
      expect(JSON.stringify(result)).not.toContain(options.password);
      expect(JSON.stringify(result)).not.toContain('private unknown');
      expect(JSON.stringify(result)).not.toContain('private path');
      expect(JSON.stringify(result)).not.toContain('private trailing path');
    } finally {
      await owner.stop();
    }
  },
);

it('captures real spawn errno without retaining the executable path', async () => {
  const owner = startObserverProcess({
    ...options,
    python: join(tmpdir(), 'PRIVATE-MISSING-OBSERVER'),
  });
  try {
    const result = await owner.closed;
    expect(result.terminal).toMatchObject({
      stage: 'spawn',
      spawnCode: 'ENOENT',
      report: 'missing',
      ready: false,
    });
    expect(JSON.stringify(result)).not.toContain('PRIVATE-MISSING-OBSERVER');
  } finally {
    await owner.stop();
  }
});
