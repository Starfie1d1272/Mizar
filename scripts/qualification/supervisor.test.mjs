import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import { setTimeout } from 'node:timers';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { readQualificationEvidence } from './evidence.mjs';
import {
  completionPage,
  finalizeQualificationRun,
  markCleanupFailure,
  runCompanionLifecycle,
  shouldCleanupQualificationState,
} from './supervisor.mjs';

const BASE_TIME = '2026-09-15T00:00:00.000Z';

function artifact() {
  return {
    schemaVersion: 1,
    repository: 'Starfie1d1272/Mizar',
    gitSha: '293f97a000000000000000000000000000000000',
    buildTimestamp: BASE_TIME,
    platform: 'win32-x64',
    nodeVersion: 'v24.21.0',
    qualificationSchemaVersion: 1,
    artifactSha256: 'a'.repeat(64),
  };
}

describe('qualification supervisor finalization', () => {
  it.each([
    ['PASS', '通过'],
    ['FAIL', '失败'],
    ['INCONCLUSIVE', '证据不足'],
  ])('renders %s as %s on the completion page', (machineResult, visibleResult) => {
    const page = completionPage({
      result: machineResult,
      reportPath: 'evidence/run/REPORT.md',
      verification: 'passed',
      cleanup: 'passed',
    });

    expect(page).toContain('<title>现场验收结果</title>');
    expect(page).toContain(`<h1>现场验收结果：${visibleResult}</h1>`);
    expect(page).not.toContain(`<h1>现场验收结果：${machineResult}</h1>`);
  });

  it('finishes and verifies evidence without stop.ps1', async () => {
    const runDir = await mkdtemp(join(tmpdir(), 'rivalhub-qualification-supervisor-'));
    const logDir = await mkdtemp(join(tmpdir(), 'rivalhub-qualification-supervisor-log-'));
    const logPath = join(logDir, 'supervisor.log');
    try {
      await mkdir(join(runDir, 'debug'), { recursive: true });
      await mkdir(join(runDir, 'recorder'), { recursive: true });
      await mkdir(join(runDir, 'logs'), { recursive: true });
      await writeFile(join(runDir, 'scenario.jsonl'), '', 'utf8');
      await writeFile(join(runDir, 'artifact.json'), `${JSON.stringify(artifact())}\n`, 'utf8');
      await writeFile(
        join(runDir, 'environment.json'),
        `${JSON.stringify({
          schemaVersion: 1,
          runId: 'supervisor-test-run',
          windowsVersion: 'Windows 11 test',
          cs2Version: 'CS2 test',
        })}\n`,
        'utf8',
      );
      await writeFile(
        join(runDir, 'debug', 'final-runtime.json'),
        '{"freshness":"fresh"}\n',
        'utf8',
      );

      const result = await finalizeQualificationRun({
        nodePath: process.execPath,
        evidenceScript: join(process.cwd(), 'scripts/qualification/evidence.mjs'),
        runDir,
        bundleRoot: process.cwd(),
        logPath,
      });

      expect(result).toMatchObject({ result: 'INCONCLUSIVE', verification: 'passed' });
      await expect(readQualificationEvidence(runDir)).resolves.toMatchObject({
        qualification: { result: 'INCONCLUSIVE' },
      });
      const report = await readFile(join(runDir, 'REPORT.md'), 'utf8');
      expect(report).toContain('# Mizar 现场验收报告');
      expect(report).not.toMatch(/INCONCLUSIVE|fresh|production chain|Capture V1/);
      await expect(readFile(join(runDir, 'REPORT.md'), 'utf8')).resolves.toContain(
        '- 运行状态：**正常**',
      );
      await expect(readFile(join(runDir, 'REPORT.md'), 'utf8')).resolves.toContain('证据不足');
      await expect(readFile(join(runDir, 'hashes.txt'), 'utf8')).resolves.toContain('REPORT.md');
    } finally {
      await rm(runDir, { recursive: true, force: true });
      await rm(logDir, { recursive: true, force: true });
    }
  });

  it('keeps cleanup failure separate from the verified qualification result', () => {
    const completion = {
      result: 'PASS',
      verification: 'passed',
      cleanup: 'pending',
      reportPath: 'evidence/run/REPORT.md',
      qualificationPath: 'evidence/run/qualification.json',
    };

    expect(markCleanupFailure(completion)).toMatchObject({
      result: 'PASS',
      verification: 'passed',
      cleanup: 'failed',
    });
    expect(shouldCleanupQualificationState({ ...completion, cleanup: 'failed' })).toBe(false);
    expect(shouldCleanupQualificationState({ ...completion, cleanup: 'passed' })).toBe(true);
    expect(
      shouldCleanupQualificationState({ ...completion, verification: 'failed', cleanup: 'passed' }),
    ).toBe(false);
  });

  it('respawns companion on exit code 75 without changing run state or finalizing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rivalhub-supervisor-lifecycle-'));
    try {
      const statePath = join(dir, 'state.json');
      await writeFile(statePath, JSON.stringify({ runId: 'run-1', processId: 100 }), 'utf8');
      const companionStdoutPath = join(dir, 'companion.log');
      const companionStderrPath = join(dir, 'companion.stderr.log');
      const supervisorLogPath = join(dir, 'supervisor.log');

      let spawns = 0;
      const mockSpawn = () => {
        spawns++;
        const currentPid = 1000 + spawns;
        const listeners = {};
        const stdout = new PassThrough();
        const stderr = new PassThrough();
        const child = {
          pid: currentPid,
          stdout,
          stderr,
          once: (event, handler) => {
            listeners[event] = handler;
          },
        };
        setTimeout(() => {
          stdout.end();
          stderr.end();
          if (spawns === 1) {
            listeners.exit?.(75, null);
          } else {
            listeners.exit?.(0, null);
          }
        }, 10);
        return child;
      };

      const result = await runCompanionLifecycle({
        nodePath: 'node',
        appRoot: dir,
        statePath,
        companionStdoutPath,
        companionStderrPath,
        supervisorLogPath,
        spawnProcess: mockSpawn,
        restartExitCode: 75,
      });

      expect(spawns).toBe(2);
      expect(result.restartCount).toBe(1);
      expect(result.exitResult.code).toBe(0);
      const state = JSON.parse(await readFile(statePath, 'utf8'));
      expect(state.runId).toBe('run-1');
      expect(state.processId).toBe(1002);
      const log = await readFile(supervisorLogPath, 'utf8');
      expect(log).toContain('捕获到受控重启退出码 75');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 15_000);
});
