import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

async function createEvidenceRun({
  complete = true,
  withCapture = true,
  captureFirstObservation = true,
  captureSecondObservation = true,
  programTelemetryCleared = true,
  observedMapChange = false,
  qualificationProfile = 'base',
} = {}) {
  const runDir = await mkdtemp(join(tmpdir(), 'rivalhub-qualification-evidence-'));
  const runId = 'qualification-test-run';
  const demoBSequence = observedMapChange ? 2 : 1;
  const demoBReceivedMonotonicMs = observedMapChange ? 20_700 : 20_600;
  const demoBMapEpoch = observedMapChange ? 3 : 2;
  const demoBRuntimeSeq = observedMapChange ? 4 : 3;
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
      qualificationProfile,
    })}\n`,
    'utf8',
  );
  await writeFile(
    join(runDir, 'debug', 'final-runtime.json'),
    `${JSON.stringify({
      freshness: 'fresh',
      ...(observedMapChange
        ? {
            recentTransitions: [
              {
                kind: 'map_execution_changed',
                reason: 'observed-map-name-change',
                runtimeSeq: 3,
                producerInstanceId: 'qualification-producer',
                mapEpoch: 3,
                previousMapEpoch: 2,
                previousMapName: 'de_ancient',
                mapName: 'de_dust2',
                sourceGeneration: 0,
                receiveSequence: 1,
                at: {
                  monotonicMs: 20_650,
                  utc: new Date(Date.parse(BASE_TIME) + 20_650).toISOString(),
                },
              },
            ],
          }
        : {}),
    })}\n`,
    'utf8',
  );

  const markers = [
    marker(runId, 'demo-a-live', 100, {
      sequence: captureFirstObservation ? 0 : 99,
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
        programTelemetryCleared,
      },
    }),
    marker(runId, 'cs2-reopened', 20_600, { freshness: 'stale', mapEpoch: 2, runtimeSeq: 2 }),
    marker(runId, 'demo-b-live', 20_800, {
      sequence: captureSecondObservation ? demoBSequence : 0,
      receivedAt: captureSecondObservation
        ? new Date(Date.parse(BASE_TIME) + demoBReceivedMonotonicMs).toISOString()
        : BASE_TIME,
      receivedMonotonicMs: captureSecondObservation ? demoBReceivedMonotonicMs : 100,
      mapEpoch: demoBMapEpoch,
      runtimeSeq: demoBRuntimeSeq,
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
        ...(captureFirstObservation
          ? [
              {
                version: 1,
                sequence: 0,
                elapsedUs: 0,
                receivedAt: BASE_TIME,
                payload: { map: { name: 'de_ancient', phase: 'live' } },
              },
            ]
          : []),
        ...(observedMapChange
          ? [
              {
                version: 1,
                sequence: 1,
                elapsedUs: 20_650_000,
                receivedAt: new Date(Date.parse(BASE_TIME) + 20_650).toISOString(),
                payload: { map: { name: 'de_dust2', phase: 'live' } },
              },
            ]
          : []),
        {
          version: 1,
          sequence: demoBSequence,
          elapsedUs: demoBReceivedMonotonicMs * 1_000,
          receivedAt: new Date(Date.parse(BASE_TIME) + demoBReceivedMonotonicMs).toISOString(),
          payload: {
            map: { name: observedMapChange ? 'de_dust2' : 'de_ancient', phase: 'live' },
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
        complete,
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
  it('writes and deterministically verifies a complete run', async () => {
    const { runDir } = await createEvidenceRun();
    try {
      const written = await writeQualificationEvidence({
        runDir,
        artifact: artifact(),
        environment: {
          runId: 'qualification-test-run',
          windowsVersion: 'Windows 11 test',
          cs2Version: 'CS2 test',
        },
      });
      expect(written.qualification.result).toBe('PASS');

      const first = await readQualificationEvidence(runDir);
      const hashesBefore = await readFile(join(runDir, 'hashes.txt'), 'utf8');
      const second = await readQualificationEvidence(runDir);
      expect(second.qualification).toEqual(first.qualification);
      expect(second.checks).toEqual(first.checks);
      expect(await readFile(join(runDir, 'hashes.txt'), 'utf8')).toBe(hashesBefore);
    } finally {
      await rm(runDir, { recursive: true, force: true });
    }
  });

  it('uses the declared objective-timing profile for the machine result', async () => {
    const run = await createEvidenceRun({ qualificationProfile: 'objective-timing' });
    try {
      const written = await writeQualificationEvidence({
        runDir: run.runDir,
        artifact: artifact(),
        environment: {
          runId: run.runId,
          windowsVersion: 'Windows 11 test',
          cs2Version: 'CS2 test',
          qualificationProfile: 'objective-timing',
        },
      });
      expect(written.qualification.profile).toBe('objective-timing');
      expect(written.qualification.objectiveTiming.foundation.result).not.toBe('PASS');
      expect(written.qualification.result).not.toBe('PASS');
      const report = await readFile(join(run.runDir, 'REPORT.md'), 'utf8');
      expect(report).toContain('- 现场验收类型：目标时钟专项验收');
      expect(report).not.toContain('现场验收类型：`objective-timing`');
      await expect(readQualificationEvidence(run.runDir)).resolves.toMatchObject({
        qualification: { profile: 'objective-timing' },
      });
    } finally {
      await rm(run.runDir, { recursive: true, force: true });
    }
  });

  it('accepts Demo B after reset when Core observes a real map-name boundary', async () => {
    const run = await createEvidenceRun({ observedMapChange: true });
    try {
      const written = await writeQualificationEvidence({
        runDir: run.runDir,
        artifact: artifact(),
        environment: {
          runId: run.runId,
          windowsVersion: 'Windows 11 test',
          cs2Version: 'CS2 test',
        },
      });
      expect(written.checks.realSilenceToStale.status).toBe('PASS');
      expect(written.checks.explicitNextExecution.status).toBe('PASS');
      expect(written.checks.demoBRecovery.status).toBe('PASS');
      expect(written.qualification.result).toBe('PASS');

      await expect(readQualificationEvidence(run.runDir)).resolves.toMatchObject({
        qualification: { result: 'PASS' },
        checks: { demoBRecovery: { status: 'PASS' } },
      });
    } finally {
      await rm(run.runDir, { recursive: true, force: true });
    }
  });

  it('does not infer Demo A production evidence from a later Demo B frame', async () => {
    const run = await createEvidenceRun({ captureFirstObservation: false });
    try {
      const written = await writeQualificationEvidence({
        runDir: run.runDir,
        artifact: artifact(),
        environment: {
          runId: run.runId,
          windowsVersion: 'Windows 11 test',
          cs2Version: 'CS2 test',
        },
      });
      expect(written.checks.productionChain.status).toBe('INCONCLUSIVE');
      expect(written.qualification.result).toBe('INCONCLUSIVE');
      await expect(readQualificationEvidence(run.runDir)).resolves.toMatchObject({
        checks: { productionChain: { status: 'INCONCLUSIVE' } },
      });
    } finally {
      await rm(run.runDir, { recursive: true, force: true });
    }
  });

  it('does not infer Demo B recovery from a pre-reset observation', async () => {
    const run = await createEvidenceRun({ captureSecondObservation: false });
    try {
      const written = await writeQualificationEvidence({
        runDir: run.runDir,
        artifact: artifact(),
        environment: {
          runId: run.runId,
          windowsVersion: 'Windows 11 test',
          cs2Version: 'CS2 test',
        },
      });
      expect(written.checks.productionChain.status).toBe('PASS');
      expect(written.checks.demoBRecovery.status).toBe('INCONCLUSIVE');
      expect(written.qualification.result).toBe('INCONCLUSIVE');
    } finally {
      await rm(run.runDir, { recursive: true, force: true });
    }
  });

  it('does not pass the reset when the previous Program telemetry was retained', async () => {
    const run = await createEvidenceRun({ programTelemetryCleared: false });
    try {
      const written = await writeQualificationEvidence({
        runDir: run.runDir,
        artifact: artifact(),
        environment: {
          runId: run.runId,
          windowsVersion: 'Windows 11 test',
          cs2Version: 'CS2 test',
        },
      });
      expect(written.checks.explicitNextExecution.status).toBe('INCONCLUSIVE');
      expect(written.checks.demoBRecovery.status).toBe('INCONCLUSIVE');
      expect(written.qualification.result).toBe('INCONCLUSIVE');
    } finally {
      await rm(run.runDir, { recursive: true, force: true });
    }
  });

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

  it('evaluates release profile host checks and renders host checkpoints in report', async () => {
    const run = await createEvidenceRun({ complete: true, qualificationProfile: 'release' });
    try {
      // 1. Without host checkpoints, release checks evaluate to INCONCLUSIVE
      const writtenInconclusive = await writeQualificationEvidence({
        runDir: run.runDir,
        artifact: artifact(),
        environment: {
          runId: run.runId,
          windowsVersion: 'Windows 11 test',
          cs2Version: 'CS2 test',
          qualificationProfile: 'release',
        },
      });
      expect(writtenInconclusive.qualification.result).toBe('INCONCLUSIVE');
      expect(writtenInconclusive.qualification.checks.browserReload).toBe('INCONCLUSIVE');
      expect(writtenInconclusive.qualification.checks.obsReload).toBe('INCONCLUSIVE');
      expect(writtenInconclusive.qualification.checks.sceneVisibility).toBe('INCONCLUSIVE');
      expect(writtenInconclusive.qualification.checks.companionRestart).toBe('INCONCLUSIVE');
      expect(writtenInconclusive.report).toContain('## Host 生产场景检查点');
      expect(writtenInconclusive.report).toContain('- 未记录 Host 检查点。');

      // 2. Reject empty recentEvents as INCONCLUSIVE (prevent false PASS)
      const emptyEventsCheckpoints = [
        {
          schemaVersion: 1,
          scenario: 'browser-reload',
          phase: 'before',
          timestamp: { monotonicMs: 1000, utc: '2026-09-15T00:00:01.000Z' },
          identity: {
            runId: run.runId,
            gitSha: artifact().gitSha,
            artifactSha256: ARTIFACT_DIGEST,
          },
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
        },
        {
          schemaVersion: 1,
          scenario: 'browser-reload',
          phase: 'after',
          timestamp: { monotonicMs: 2000, utc: '2026-09-15T00:00:02.000Z' },
          identity: {
            runId: run.runId,
            gitSha: artifact().gitSha,
            artifactSha256: ARTIFACT_DIGEST,
          },
          runtime: {
            producerInstanceId: 'inst-1',
            freshness: 'fresh',
            mapEpoch: 1,
            sourceGeneration: 0,
            runtimeSeq: 2,
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
          programVisible: true,
        },
      ];
      await writeFile(
        join(run.runDir, 'host-checkpoints.jsonl'),
        emptyEventsCheckpoints.map((cp) => JSON.stringify(cp)).join('\n') + '\n',
        'utf8',
      );
      const writtenNoAction = await writeQualificationEvidence({
        runDir: run.runDir,
        artifact: artifact(),
        environment: {
          runId: run.runId,
          windowsVersion: 'Windows 11 test',
          cs2Version: 'CS2 test',
          qualificationProfile: 'release',
        },
      });
      expect(writtenNoAction.qualification.checks.browserReload).toBe('INCONCLUSIVE');
      expect(writtenNoAction.qualification.result).toBe('INCONCLUSIVE');

      // 3. Add complete host checkpoints with authentic event causality
      const hostCheckpoints = [
        {
          schemaVersion: 1,
          scenario: 'browser-reload',
          phase: 'before',
          timestamp: { monotonicMs: 1000, utc: '2026-09-15T00:00:01.000Z' },
          identity: {
            runId: run.runId,
            gitSha: artifact().gitSha,
            artifactSha256: ARTIFACT_DIGEST,
          },
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
            recentEvents: [
              {
                sequence: 1,
                at: '2026-09-15T00:00:01.000Z',
                action: 'connected',
                host: 'browser',
                channel: 'program',
              },
            ],
          },
        },
        {
          schemaVersion: 1,
          scenario: 'browser-reload',
          phase: 'after',
          timestamp: { monotonicMs: 2000, utc: '2026-09-15T00:00:02.000Z' },
          identity: {
            runId: run.runId,
            gitSha: artifact().gitSha,
            artifactSha256: ARTIFACT_DIGEST,
          },
          runtime: {
            producerInstanceId: 'inst-1',
            freshness: 'fresh',
            mapEpoch: 1,
            sourceGeneration: 0,
            runtimeSeq: 2,
          },
          host: {
            active: { obs: 1, browser: 1, unknown: 0 },
            byHostChannel: {
              obs: { program: 1, radar: 0, operator: 0, assist: 0, 'program-cue': 0 },
              browser: { program: 1, radar: 0, operator: 0, assist: 0, 'program-cue': 0 },
              unknown: { program: 0, radar: 0, operator: 0, assist: 0, 'program-cue': 0 },
            },
            obsVersions: ['31.0.0'],
            recentEvents: [
              {
                sequence: 1,
                at: '2026-09-15T00:00:01.000Z',
                action: 'connected',
                host: 'browser',
                channel: 'program',
              },
              {
                sequence: 2,
                at: '2026-09-15T00:00:01.500Z',
                action: 'disconnected',
                host: 'browser',
                channel: 'program',
              },
              {
                sequence: 3,
                at: '2026-09-15T00:00:02.000Z',
                action: 'connected',
                host: 'browser',
                channel: 'program',
              },
            ],
          },
          programVisible: true,
        },
        {
          schemaVersion: 1,
          scenario: 'obs-reload',
          phase: 'before',
          timestamp: { monotonicMs: 3000, utc: '2026-09-15T00:00:03.000Z' },
          identity: {
            runId: run.runId,
            gitSha: artifact().gitSha,
            artifactSha256: ARTIFACT_DIGEST,
          },
          runtime: {
            producerInstanceId: 'inst-1',
            freshness: 'fresh',
            mapEpoch: 1,
            sourceGeneration: 0,
            runtimeSeq: 3,
          },
          host: {
            active: { obs: 1, browser: 0, unknown: 0 },
            byHostChannel: {
              obs: { program: 1, radar: 0, operator: 0, assist: 0, 'program-cue': 0 },
              browser: { program: 0, radar: 0, operator: 0, assist: 0, 'program-cue': 0 },
              unknown: { program: 0, radar: 0, operator: 0, assist: 0, 'program-cue': 0 },
            },
            obsVersions: ['31.0.0'],
            recentEvents: [
              {
                sequence: 3,
                at: '2026-09-15T00:00:02.000Z',
                action: 'connected',
                host: 'browser',
                channel: 'program',
              },
            ],
          },
        },
        {
          schemaVersion: 1,
          scenario: 'obs-reload',
          phase: 'after',
          timestamp: { monotonicMs: 4000, utc: '2026-09-15T00:00:04.000Z' },
          identity: {
            runId: run.runId,
            gitSha: artifact().gitSha,
            artifactSha256: ARTIFACT_DIGEST,
          },
          runtime: {
            producerInstanceId: 'inst-1',
            freshness: 'fresh',
            mapEpoch: 1,
            sourceGeneration: 0,
            runtimeSeq: 4,
          },
          host: {
            active: { obs: 1, browser: 0, unknown: 0 },
            byHostChannel: {
              obs: { program: 1, radar: 0, operator: 0, assist: 0, 'program-cue': 0 },
              browser: { program: 0, radar: 0, operator: 0, assist: 0, 'program-cue': 0 },
              unknown: { program: 0, radar: 0, operator: 0, assist: 0, 'program-cue': 0 },
            },
            obsVersions: ['31.0.0'],
            recentEvents: [
              {
                sequence: 4,
                at: '2026-09-15T00:00:03.500Z',
                action: 'disconnected',
                host: 'obs',
                channel: 'program',
              },
              {
                sequence: 5,
                at: '2026-09-15T00:00:04.000Z',
                action: 'connected',
                host: 'obs',
                channel: 'program',
              },
            ],
          },
          programVisible: true,
        },
        {
          schemaVersion: 1,
          scenario: 'scene-visibility',
          phase: 'before',
          timestamp: { monotonicMs: 5000, utc: '2026-09-15T00:00:05.000Z' },
          identity: {
            runId: run.runId,
            gitSha: artifact().gitSha,
            artifactSha256: ARTIFACT_DIGEST,
          },
          runtime: {
            producerInstanceId: 'inst-1',
            freshness: 'fresh',
            mapEpoch: 1,
            sourceGeneration: 0,
            runtimeSeq: 5,
          },
          host: {
            active: { obs: 1, browser: 0, unknown: 0 },
            byHostChannel: {
              obs: { program: 1, radar: 0, operator: 0, assist: 0, 'program-cue': 0 },
              browser: { program: 0, radar: 0, operator: 0, assist: 0, 'program-cue': 0 },
              unknown: { program: 0, radar: 0, operator: 0, assist: 0, 'program-cue': 0 },
            },
            obsVersions: ['31.0.0'],
            recentEvents: [
              {
                sequence: 5,
                at: '2026-09-15T00:00:04.000Z',
                action: 'connected',
                host: 'obs',
                channel: 'program',
              },
            ],
          },
        },
        {
          schemaVersion: 1,
          scenario: 'scene-visibility',
          phase: 'after',
          timestamp: { monotonicMs: 6000, utc: '2026-09-15T00:00:06.000Z' },
          identity: {
            runId: run.runId,
            gitSha: artifact().gitSha,
            artifactSha256: ARTIFACT_DIGEST,
          },
          runtime: {
            producerInstanceId: 'inst-1',
            freshness: 'fresh',
            mapEpoch: 1,
            sourceGeneration: 0,
            runtimeSeq: 6,
          },
          host: {
            active: { obs: 1, browser: 0, unknown: 0 },
            byHostChannel: {
              obs: { program: 1, radar: 0, operator: 0, assist: 0, 'program-cue': 0 },
              browser: { program: 0, radar: 0, operator: 0, assist: 0, 'program-cue': 0 },
              unknown: { program: 0, radar: 0, operator: 0, assist: 0, 'program-cue': 0 },
            },
            obsVersions: ['31.0.0'],
            recentEvents: [
              {
                sequence: 5,
                at: '2026-09-15T00:00:04.000Z',
                action: 'connected',
                host: 'obs',
                channel: 'program',
              },
            ],
          },
          programVisible: true,
        },
        {
          schemaVersion: 1,
          scenario: 'companion-restart',
          phase: 'before',
          timestamp: { monotonicMs: 7000, utc: '2026-09-15T00:00:07.000Z' },
          identity: {
            runId: run.runId,
            gitSha: artifact().gitSha,
            artifactSha256: ARTIFACT_DIGEST,
          },
          runtime: {
            producerInstanceId: 'inst-1',
            freshness: 'fresh',
            mapEpoch: 1,
            sourceGeneration: 0,
            runtimeSeq: 7,
          },
          host: {
            active: { obs: 1, browser: 0, unknown: 0 },
            byHostChannel: {
              obs: { program: 1, radar: 0, operator: 0, assist: 0, 'program-cue': 0 },
              browser: { program: 0, radar: 0, operator: 0, assist: 0, 'program-cue': 0 },
              unknown: { program: 0, radar: 0, operator: 0, assist: 0, 'program-cue': 0 },
            },
            obsVersions: ['31.0.0'],
            recentEvents: [
              {
                sequence: 5,
                at: '2026-09-15T00:00:04.000Z',
                action: 'connected',
                host: 'obs',
                channel: 'program',
              },
            ],
          },
        },
        {
          schemaVersion: 1,
          scenario: 'companion-restart',
          phase: 'after',
          timestamp: { monotonicMs: 8000, utc: '2026-09-15T00:00:08.000Z' },
          identity: {
            runId: run.runId,
            gitSha: artifact().gitSha,
            artifactSha256: ARTIFACT_DIGEST,
          },
          runtime: {
            producerInstanceId: 'inst-2',
            freshness: 'fresh',
            mapEpoch: 1,
            sourceGeneration: 0,
            runtimeSeq: 8,
          },
          host: {
            active: { obs: 1, browser: 0, unknown: 0 },
            byHostChannel: {
              obs: { program: 1, radar: 0, operator: 0, assist: 0, 'program-cue': 0 },
              browser: { program: 0, radar: 0, operator: 0, assist: 0, 'program-cue': 0 },
              unknown: { program: 0, radar: 0, operator: 0, assist: 0, 'program-cue': 0 },
            },
            obsVersions: ['31.0.0'],
            recentEvents: [
              {
                sequence: 1,
                at: '2026-09-15T00:00:08.000Z',
                action: 'connected',
                host: 'obs',
                channel: 'program',
              },
            ],
          },
          programVisible: true,
        },
      ];
      await writeFile(
        join(run.runDir, 'host-checkpoints.jsonl'),
        hostCheckpoints.map((cp) => JSON.stringify(cp)).join('\n') + '\n',
        'utf8',
      );

      const writtenPass = await writeQualificationEvidence({
        runDir: run.runDir,
        artifact: artifact(),
        environment: {
          runId: run.runId,
          windowsVersion: 'Windows 11 test',
          cs2Version: 'CS2 test',
          qualificationProfile: 'release',
        },
      });
      expect(writtenPass.qualification.result).toBe('PASS');
      expect(writtenPass.qualification.checks.browserReload).toBe('PASS');
      expect(writtenPass.qualification.checks.obsReload).toBe('PASS');
      expect(writtenPass.qualification.checks.sceneVisibility).toBe('PASS');
      expect(writtenPass.qualification.checks.companionRestart).toBe('PASS');
      expect(writtenPass.report).toContain('普通浏览器重载（后）');
      expect(writtenPass.report).toContain('制播服务受控重启（后）');

      const verified = await readQualificationEvidence(run.runDir);
      expect(verified.qualification.result).toBe('PASS');
      expect(verified.environment.finishedAt).toBeDefined();
      expect(verified.environment.obsVersions).toEqual(['31.0.0']);

      // A bounded recent-event window cannot prove absence if events since the
      // before checkpoint have already been truncated from the ring.
      const truncatedSceneWindow = hostCheckpoints.map((checkpoint) =>
        checkpoint.scenario === 'scene-visibility' && checkpoint.phase === 'after'
          ? {
              ...checkpoint,
              host: {
                ...checkpoint.host,
                recentEvents: [
                  {
                    sequence: 7,
                    at: '2026-09-15T00:00:06.000Z',
                    action: 'connected',
                    host: 'browser',
                    channel: 'operator',
                  },
                ],
              },
            }
          : checkpoint,
      );
      await writeFile(
        join(run.runDir, 'host-checkpoints.jsonl'),
        truncatedSceneWindow.map((checkpoint) => JSON.stringify(checkpoint)).join('\n') + '\n',
        'utf8',
      );
      const truncatedWindowResult = await writeQualificationEvidence({
        runDir: run.runDir,
        artifact: artifact(),
        environment: {
          runId: run.runId,
          windowsVersion: 'Windows 11 test',
          cs2Version: 'CS2 test',
          qualificationProfile: 'release',
        },
      });
      expect(truncatedWindowResult.qualification.checks.sceneVisibility).toBe('INCONCLUSIVE');
      expect(truncatedWindowResult.qualification.result).toBe('INCONCLUSIVE');
    } finally {
      await rm(run.runDir, { recursive: true, force: true });
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
