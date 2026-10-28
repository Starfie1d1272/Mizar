import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  readQualificationEvidence,
  scanJsonForSecrets,
  validateHostCheckpoint,
  writeQualificationEvidence,
} from './evidence.mjs';

const ARTIFACT_DIGEST = 'a'.repeat(64);
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
    artifactSha256: ARTIFACT_DIGEST,
  };
}

function marker(runId, kind, monotonicMs, options = {}) {
  const mapEpoch = options.mapEpoch ?? 1;
  const runtimeSeq = options.runtimeSeq ?? 1;
  const freshness = options.freshness ?? 'fresh';
  const receivedMonotonicMs = options.receivedMonotonicMs ?? monotonicMs;
  return {
    schemaVersion: 1,
    runId,
    kind,
    monotonicMs,
    wallClockAt: new Date(Date.parse(BASE_TIME) + monotonicMs).toISOString(),
    producerInstanceId: 'qualification-producer',
    mapEpoch,
    runtimeSeq,
    sourceGeneration: 0,
    freshness,
    observation:
      options.observation === null
        ? null
        : {
            sequence: options.sequence ?? 0,
            receivedAt:
              options.receivedAt ??
              new Date(Date.parse(BASE_TIME) + receivedMonotonicMs).toISOString(),
            receivedMonotonicMs,
            producerInstanceId: 'qualification-producer',
            sourceGeneration: 0,
            mapEpoch,
            runtimeSeq,
            freshness,
          },
    ...(options.phase === undefined ? {} : { phase: options.phase }),
    ...(options.reset === undefined ? {} : { reset: options.reset }),
  };
}

async function createEvidenceRun({ withCapture = true } = {}) {
  const runDir = await mkdtemp(join(tmpdir(), 'rivalhub-qualification-evidence-'));
  const runId = 'qualification-test-run';
  await mkdir(join(runDir, 'debug'), { recursive: true });
  await mkdir(join(runDir, 'recorder'), { recursive: true });
  await writeFile(join(runDir, 'scenario.jsonl'), '', 'utf8');
  await writeFile(join(runDir, 'artifact.json'), `${JSON.stringify(artifact())}\n`, 'utf8');
  await writeFile(
    join(runDir, 'environment.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      runId,
      windowsVersion: 'Windows 11 test',
      cs2Version: 'CS2 test',
      qualificationProfile: 'base',
    })}\n`,
    'utf8',
  );
  await writeFile(
    join(runDir, 'debug', 'final-runtime.json'),
    `${JSON.stringify({
      freshness: 'fresh',
    })}\n`,
    'utf8',
  );

  const markers = [
    marker(runId, 'demo-a-live', 100, {
      sequence: 0,
      receivedAt: BASE_TIME,
      receivedMonotonicMs: 100,
    }),
    marker(runId, 'runtime-stale', 20_300, { freshness: 'stale' }),
    marker(runId, 'cs2-closed', 20_400, { freshness: 'stale' }),
    marker(runId, 'next-execution', 20_500, { freshness: 'stale', phase: 'before' }),
    marker(runId, 'next-execution', 20_501, {
      freshness: 'stale',
      phase: 'after',
      mapEpoch: 2,
      runtimeSeq: 2,
      reset: {
        disposition: 'accepted',
        reason: 'map-execution-reset',
        resetReason: 'operator-correction',
        previousMapEpoch: 1,
        mapEpoch: 2,
        programTelemetryCleared: true,
      },
    }),
    marker(runId, 'cs2-reopened', 20_600, { freshness: 'stale', mapEpoch: 2, runtimeSeq: 2 }),
    marker(runId, 'demo-b-live', 20_800, {
      sequence: 1,
      receivedAt: new Date(Date.parse(BASE_TIME) + 20_600).toISOString(),
      receivedMonotonicMs: 20_600,
      mapEpoch: 2,
      runtimeSeq: 3,
    }),
  ];
  await writeFile(
    join(runDir, 'scenario.jsonl'),
    `${markers.map((value) => JSON.stringify(value)).join('\n')}\n`,
    'utf8',
  );

  if (withCapture) {
    const frames =
      [
        {
          version: 1,
          sequence: 0,
          elapsedUs: 0,
          receivedAt: BASE_TIME,
          payload: { map: { name: 'de_ancient', phase: 'live' } },
        },
        {
          version: 1,
          sequence: 1,
          elapsedUs: 20_600_000,
          receivedAt: new Date(Date.parse(BASE_TIME) + 20_600).toISOString(),
          payload: {
            map: { name: 'de_ancient', phase: 'live' },
          },
        },
      ]
        .map((frame) => JSON.stringify(frame))
        .join('\n') + '\n';
    const captureDir = join(runDir, 'recorder', 'capture-1');
    await mkdir(captureDir, { recursive: true });
    await writeFile(join(captureDir, 'frames.jsonl'), frames, 'utf8');
    await writeFile(
      join(captureDir, 'manifest.json'),
      `${JSON.stringify({
        formatVersion: 1,
        captureId: 'capture-1',
        createdAt: BASE_TIME,
        platform: 'win32-x64',
        broadcastCommit: artifact().gitSha,
        scenario: 'qualification-test',
        gsiConfig: { uri: 'http://127.0.0.1:3000/gsi' },
        complete: true,
        frameCount: frames.trimEnd().split('\n').length,
        droppedFrames: 0,
        framesSha256: createHash('sha256').update(frames, 'utf8').digest('hex'),
      })}\n`,
      'utf8',
    );
  }
  return { runDir, runId };
}

describe('qualification evidence verifier', () => {
  it('detects tampered report bytes and does not treat inconclusive as a verifier error', async () => {
    const completeRun = await createEvidenceRun();
    try {
      await writeQualificationEvidence({
        runDir: completeRun.runDir,
        artifact: artifact(),
        environment: {
          runId: completeRun.runId,
          windowsVersion: 'Windows 11 test',
          cs2Version: 'CS2 test',
        },
      });
      await writeFile(join(completeRun.runDir, 'REPORT.md'), 'tampered\n', 'utf8');
      await expect(readQualificationEvidence(completeRun.runDir)).rejects.toMatchObject({
        code: 'HASH_MISMATCH',
      });
    } finally {
      await rm(completeRun.runDir, { recursive: true, force: true });
    }

    const incompleteRun = await createEvidenceRun({ withCapture: false });
    try {
      await writeFile(join(incompleteRun.runDir, 'scenario.jsonl'), '', 'utf8');
      await rm(join(incompleteRun.runDir, 'debug', 'final-runtime.json'), { force: true });
      const written = await writeQualificationEvidence({
        runDir: incompleteRun.runDir,
        artifact: artifact(),
        environment: {
          runId: incompleteRun.runId,
          windowsVersion: 'unknown',
          cs2Version: 'unknown',
        },
      });
      expect(written.qualification.result).toBe('INCONCLUSIVE');
      await expect(readQualificationEvidence(incompleteRun.runDir)).resolves.toMatchObject({
        qualification: { result: 'INCONCLUSIVE' },
      });
    } finally {
      await rm(incompleteRun.runDir, { recursive: true, force: true });
    }
  });

  it('rejects secret-bearing evidence fields', () => {
    expect(() => scanJsonForSecrets({ token: 'must-not-ship' })).toThrow('不应公开的敏感值');
    expect(() => scanJsonForSecrets({ player: '76561198000000001' })).toThrow('Steam 身份');
  });

  it('rejects host checkpoint with mismatched gitSha or artifactSha256', () => {
    const validCp = {
      schemaVersion: 1,
      scenario: 'browser-reload',
      phase: 'before',
      timestamp: { monotonicMs: 1000, utc: '2026-09-15T00:00:01.000Z' },
      identity: { runId: 'run-1', gitSha: 'wrong-git-sha', artifactSha256: ARTIFACT_DIGEST },
      runtime: {
        producerInstanceId: 'inst-1',
        freshness: 'fresh',
        mapEpoch: 1,
        sourceGeneration: 0,
        runtimeSeq: 1,
      },
      host: {
        active: { obs: 1, browser: 1, unknown: 0 },
        byHostChannel: {
          obs: { program: 1, radar: 0, operator: 0, assist: 0, 'program-cue': 0 },
          browser: { program: 1, radar: 0, operator: 0, assist: 0, 'program-cue': 0 },
          unknown: { program: 0, radar: 0, operator: 0, assist: 0, 'program-cue': 0 },
        },
        obsVersions: ['31.0.0'],
        recentEvents: [],
      },
    };
    expect(() => validateHostCheckpoint(validCp, 'run-1', 1, artifact())).toThrow(
      '代码提交与本次 artifact.json 不一致',
    );

    const wrongShaCp = {
      ...validCp,
      identity: {
        runId: 'run-1',
        gitSha: artifact().gitSha,
        artifactSha256: '0000000000000000000000000000000000000000000000000000000000000000',
      },
    };
    expect(() => validateHostCheckpoint(wrongShaCp, 'run-1', 1, artifact())).toThrow(
      '产物摘要与本次 artifact.json 不一致',
    );
  });
});
