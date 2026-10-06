import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import {
  createInitialRuntimeState,
  reduceRuntime,
  type RuntimeContinuityPolicy,
  type RuntimeDisposition,
  type RuntimeState,
  type RuntimeTransition,
} from '@mizar/core/runtime';
import { describe, expect, it } from 'vitest';

import { verifyCapture } from '../src/capture/reader.js';
import { replayCapture } from '../src/replay/runner.js';
import type { ReplayFaultPlanV1, ReplayEvent } from '../src/replay/types.js';
import { replayPayload, testFrame, writeCapture } from './helpers.js';

const REPLAY_POLICY: RuntimeContinuityPolicy = { staleAfterMs: Number.MAX_SAFE_INTEGER };

interface RuntimeReplayResult {
  readonly state: RuntimeState;
  readonly dispositions: readonly RuntimeDisposition[];
  readonly transitions: readonly RuntimeTransition[];
}

async function replayRuntime(
  captureDir: string,
  faultPlan?: ReplayFaultPlanV1,
  policy: RuntimeContinuityPolicy = REPLAY_POLICY,
): Promise<RuntimeReplayResult> {
  const capture = await verifyCapture(captureDir);
  let state = createInitialRuntimeState('replay-producer');
  let sourceGeneration = 0;
  const dispositions: RuntimeDisposition[] = [];
  const transitions: RuntimeTransition[] = [];

  for await (const event of replayCapture(capture, {
    mode: { kind: 'step' },
    ...(faultPlan === undefined ? {} : { faultPlan }),
  })) {
    const result = reduceReplayEvent(state, event, sourceGeneration, policy);
    state = result.state;
    dispositions.push(result.disposition);
    transitions.push(...result.transitions);
    if (event.kind === 'source-generation-boundary') sourceGeneration = event.generation;
  }

  return { state, dispositions, transitions };
}

function reduceReplayEvent(
  state: RuntimeState,
  event: ReplayEvent,
  sourceGeneration: number,
  policy: RuntimeContinuityPolicy,
) {
  if (event.kind === 'source-generation-boundary') {
    return reduceRuntime(
      state,
      {
        kind: 'advance-program-source-generation',
        nextGeneration: event.generation,
        at: {
          monotonicMs: event.scheduledElapsedUs / 1000,
          utc: '2026-09-14T00:00:00.000Z',
        },
      },
      policy,
    );
  }

  if (!event.result.ok) {
    throw new Error(`replay adapter failed at captureIndex ${event.captureIndex}`);
  }
  return reduceRuntime(
    state,
    {
      kind: 'program-telemetry',
      sourceGeneration,
      observation: event.result.observation,
    },
    policy,
  );
}

function runtimePayload(
  mapPhase: 'live' | 'gameover',
  roundPhase: 'freezetime' | 'live' | 'over',
  mapName = 'de_mirage',
): Record<string, unknown> {
  return {
    ...replayPayload(0),
    map: { name: mapName, phase: mapPhase, round: 1 },
    round: { phase: roundPhase, win_team: 'CT' },
  };
}

async function temporaryDirectory(): Promise<string> {
  return mkdtemp(resolve(tmpdir(), 'rivalhub-runtime-replay-'));
}

describe('Core RuntimeState through production adapter replay', () => {
  it('replays real semantic evidence without a spurious map transition', async () => {
    const capture = await replayRuntime(
      resolve(process.cwd(), 'fixtures/gsi/semantic/match/halftime-side-switch'),
    );

    expect(capture.state.map).toEqual({ epoch: 1, name: 'de_ancient', competitiveObserved: true });
    expect(capture.state.programTelemetry).toBeDefined();
    expect(capture.transitions.filter(({ kind }) => kind === 'map_execution_changed')).toEqual([]);
  });

  it('derives exactly one map_ended from the real gameover semantic fixture', async () => {
    const replay = await replayRuntime(
      resolve(process.cwd(), 'fixtures/gsi/semantic/match/gameover'),
    );

    expect(replay.state.map).toEqual({ epoch: 1, name: 'de_ancient', competitiveObserved: true });
    expect(replay.transitions.filter(({ kind }) => kind === 'map_ended')).toHaveLength(1);
    expect(replay.transitions.filter(({ kind }) => kind === 'map_execution_changed')).toEqual([]);
  });

  it('keeps one map execution across the real regulation-to-overtime fixture', async () => {
    const replay = await replayRuntime(
      resolve(process.cwd(), 'fixtures/gsi/semantic/match/regulation-to-overtime'),
    );

    expect(replay.state.map).toEqual({ epoch: 1, name: 'de_ancient', competitiveObserved: true });
    expect(replay.transitions.filter(({ kind }) => kind === 'map_execution_changed')).toEqual([]);
  });

  it('replays the real overtime side-switch fixture without a map transition', async () => {
    const replay = await replayRuntime(
      resolve(process.cwd(), 'fixtures/gsi/semantic/match/overtime-side-switch'),
    );

    expect(replay.state.map).toEqual({ epoch: 1, name: 'de_ancient', competitiveObserved: true });
    expect(replay.transitions.filter(({ kind }) => kind === 'map_execution_changed')).toEqual([]);
  });

  it('replays the same semantic capture deterministically', async () => {
    const capturePath = resolve(process.cwd(), 'fixtures/gsi/semantic/match/gameover');
    const first = await replayRuntime(capturePath);
    const second = await replayRuntime(capturePath);

    expect(second).toEqual(first);
  });

  it('replays the same inputs, replay clock, and explicit controls deterministically', async () => {
    const root = await temporaryDirectory();
    try {
      await writeCapture(root, [
        testFrame(1, 1_000, runtimePayload('live', 'freezetime')),
        testFrame(2, 2_000, runtimePayload('live', 'live')),
        testFrame(3, 3_000, runtimePayload('live', 'over')),
      ]);
      const faultPlan = {
        timeGap: [{ afterCaptureIndex: 0, gapUs: 101_000 }],
        sourceGenerationBoundary: [{ beforeCaptureIndex: 2 }],
      } as const;

      const first = await replayRuntime(root, faultPlan);
      const second = await replayRuntime(root, faultPlan);

      expect(second).toEqual(first);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('uses the replay source-generation boundary as an explicit Core control', async () => {
    const root = await temporaryDirectory();
    try {
      await writeCapture(root, [
        testFrame(1, 1_000, runtimePayload('live', 'freezetime')),
        testFrame(2, 2_000, runtimePayload('live', 'live')),
        testFrame(3, 3_000, runtimePayload('live', 'over')),
        testFrame(4, 4_000, runtimePayload('live', 'live')),
      ]);
      const replay = await replayRuntime(root, {
        sourceGenerationBoundary: [{ beforeCaptureIndex: 2 }],
      });

      expect(replay.state.map).toEqual({ epoch: 1, name: 'de_mirage', competitiveObserved: true });
      expect(replay.state.programSource).toMatchObject({ generation: 1 });
      expect(replay.state.programTelemetry?.receive.sequence).toBe(4);
      expect(replay.dispositions).toEqual([
        { kind: 'accepted', reason: 'baseline' },
        { kind: 'accepted', reason: 'contiguous' },
        { kind: 'accepted', reason: 'source-generation-advanced' },
        { kind: 'accepted', reason: 'contiguous' },
        { kind: 'accepted', reason: 'contiguous' },
      ]);
      expect(replay.transitions.filter(({ kind }) => kind === 'round_ended')).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('accepts a replay gap as current truth without inventing an edge across missing frames', async () => {
    const root = await temporaryDirectory();
    try {
      await writeCapture(root, [
        testFrame(1, 1_000, runtimePayload('live', 'freezetime')),
        testFrame(2, 2_000, runtimePayload('live', 'live')),
        testFrame(3, 3_000, runtimePayload('live', 'over')),
      ]);
      const replay = await replayRuntime(root, { drop: [1] });

      expect(replay.dispositions).toEqual([
        { kind: 'accepted', reason: 'baseline' },
        {
          kind: 'accepted',
          reason: 'gap-resync',
          missingSequenceRange: { from: 2, to: 2 },
        },
      ]);
      expect(replay.state.programTelemetry?.receive.sequence).toBe(3);
      expect(replay.transitions).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('routes a replay time gap beyond staleAfterMs through stale recovery', async () => {
    const root = await temporaryDirectory();
    try {
      await writeCapture(root, [
        testFrame(1, 1_000, runtimePayload('live', 'freezetime')),
        testFrame(2, 2_000, runtimePayload('live', 'live')),
      ]);
      const replay = await replayRuntime(
        root,
        { timeGap: [{ afterCaptureIndex: 0, gapUs: 101_000 }] },
        { staleAfterMs: 100 },
      );

      expect(replay.dispositions).toEqual([
        { kind: 'accepted', reason: 'baseline' },
        { kind: 'accepted', reason: 'stale-recovery' },
      ]);
      expect(replay.transitions).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps duplicate and adjacent-reorder inputs fail-closed at the reducer boundary', async () => {
    const root = await temporaryDirectory();
    try {
      await writeCapture(root, [
        testFrame(1, 1_000, runtimePayload('live', 'freezetime')),
        testFrame(2, 2_000, runtimePayload('live', 'live')),
        testFrame(3, 3_000, runtimePayload('live', 'over')),
        testFrame(4, 4_000, runtimePayload('live', 'live')),
      ]);

      const duplicate = await replayRuntime(root, {
        duplicate: [{ captureIndex: 1, copies: 1 }],
      });
      expect(duplicate.dispositions).toEqual([
        { kind: 'accepted', reason: 'baseline' },
        { kind: 'accepted', reason: 'contiguous' },
        { kind: 'ignored', reason: 'duplicate' },
        { kind: 'accepted', reason: 'contiguous' },
        { kind: 'accepted', reason: 'contiguous' },
      ]);
      expect(duplicate.transitions.map(({ kind }) => kind)).toEqual([
        'round_started',
        'round_ended',
      ]);

      const reordered = await replayRuntime(root, { reorderAdjacent: [1] });
      expect(reordered.dispositions).toEqual([
        { kind: 'accepted', reason: 'baseline' },
        {
          kind: 'accepted',
          reason: 'gap-resync',
          missingSequenceRange: { from: 2, to: 2 },
        },
        { kind: 'ignored', reason: 'out-of-order' },
        { kind: 'accepted', reason: 'contiguous' },
      ]);
      expect(reordered.transitions).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
