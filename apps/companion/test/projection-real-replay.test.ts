import { createHash } from 'node:crypto';

import { assistSnapshotSchema } from '@mizar/protocol/assist';
import { operatorSnapshotSchema } from '@mizar/protocol/operator';
import { programSnapshotSchema } from '@mizar/protocol/program';
import { radarSnapshotSchema } from '@mizar/protocol/radar';
import {
  canonicalJsonLine,
  verifyCapture,
  type ReplayFaultPlanV1,
  type VerifiedCapture,
} from '@mizar/testkit';
import { describe, expect, it } from 'vitest';

import type { createProjectionCoordinator } from '../src/projections/projection-coordinator.js';
import { replayRealProgram } from './support/real-program-replay.js';

const fullMatchCaptureDir = process.env.RIVALHUB_FULL_MATCH_CAPTURE_DIR;
const FULL_MATCH_CAPTURE_ID = '20260914T060149Z-4cda66b7-recovered-match';
const FULL_MATCH_FRAME_COUNT = 16_382;
const FULL_MATCH_FRAMES_SHA256 = '7a2dfed10f28903de6a94e782ca3f0955593fe2f653e7e831e05305d8e99347a';
const FULL_MATCH_SOURCE_GENERATION_BOUNDARY_INDEX = 2_000;
const FULL_MATCH_MAP_RESET_INDEX = 10_000;
const FULL_MATCH_FAULT_PLAN: ReplayFaultPlanV1 = {
  sourceGenerationBoundary: [{ beforeCaptureIndex: FULL_MATCH_SOURCE_GENERATION_BOUNDARY_INDEX }],
};

interface ReplayPipelineResult {
  readonly frames: number;
  readonly accepted: number;
  readonly digest: string;
  readonly finalRuntimeSeq: number;
  readonly finalMapName: string | null;
  readonly finalMapEpoch: number;
  readonly finalIdentityState: string;
  readonly finalIdentitySourceGeneration: number;
  readonly finalIdentityMapEpoch: number;
  readonly identityStates: readonly string[];
  readonly sideMappings: readonly string[];
  readonly faultBoundaryStates: readonly string[];
}

function normalizeChannelSeq<T extends { readonly channelSeq: number }>(
  snapshot: T,
): Omit<T, 'channelSeq'> {
  const { channelSeq, ...rest } = snapshot;
  void channelSeq;
  return rest;
}

function digestSnapshots(
  digest: ReturnType<typeof createHash>,
  coordinator: ReturnType<typeof createProjectionCoordinator>,
): void {
  const bundle = coordinator.getCurrent();
  const program = programSnapshotSchema.parse(coordinator.getPublisher('program').getCurrent());
  const radar = radarSnapshotSchema.parse(coordinator.getPublisher('radar').getCurrent());
  const operator = operatorSnapshotSchema.parse(coordinator.getPublisher('operator').getCurrent());
  const assist = assistSnapshotSchema.parse(coordinator.getPublisher('assist').getCurrent());

  expect(program.cursor).toEqual(bundle.program.cursor);
  expect(radar.cursor).toEqual(bundle.radar.cursor);
  expect(operator.cursor).toEqual(bundle.operator.cursor);
  expect(assist.cursor).toEqual(bundle.assist.cursor);
  digest.update(
    canonicalJsonLine({
      projection: {
        program: bundle.program,
        radar: bundle.radar,
        operator: bundle.operator,
        assist: bundle.assist,
        identity: bundle.identity,
      },
      wire: {
        program: normalizeChannelSeq(program),
        radar: normalizeChannelSeq(radar),
        operator: normalizeChannelSeq(operator),
        assist: normalizeChannelSeq(assist),
      },
    }),
  );
}

async function runPipeline(
  capture: VerifiedCapture,
  faultPlan?: ReplayFaultPlanV1,
): Promise<ReplayPipelineResult> {
  const digest = createHash('sha256');
  const identityStates = new Set<string>();
  const sideMappings = new Set<string>();
  const faultBoundaryStates: string[] = [];
  let final: ReturnType<ReturnType<typeof createProjectionCoordinator>['getCurrent']> | undefined;
  const result = await replayRealProgram({
    capturePath: capture.directory,
    ...(faultPlan === undefined ? {} : { faultPlan }),
    onStart: ({ coordinator }) => digestSnapshots(digest, coordinator),
    beforeEvent: (event, { runtime, coordinator }) => {
      if (
        faultPlan !== undefined &&
        event.kind === 'frame' &&
        event.captureIndex === FULL_MATCH_MAP_RESET_INDEX &&
        event.occurrence === 0
      ) {
        const reset = runtime.resetMapExecution('same-map-restart', {
          monotonicMs: event.receiveContext.receivedMonotonicMs,
          utc: event.receiveContext.receivedAt,
        });
        expect(reset.disposition).toEqual({ kind: 'accepted', reason: 'map-execution-reset' });
        coordinator.afterRuntimeMutation(reset);
        const current = coordinator.getCurrent();
        faultBoundaryStates.push(
          `map-execution-reset:${current.program.status.identity}:${current.radar.identityState}:${current.program.teams.ct.mode}:${current.program.cursor.programSourceGeneration}:${current.program.cursor.mapEpoch}`,
        );
        digestSnapshots(digest, coordinator);
      }
    },
    afterEvent: (event, { coordinator }) => {
      const current = coordinator.getCurrent();
      if (event.kind === 'source-generation-boundary') {
        faultBoundaryStates.push(
          `source-generation-advanced:${current.program.status.identity}:${current.radar.identityState}:${current.program.teams.ct.mode}:${current.program.cursor.programSourceGeneration}:${current.program.cursor.mapEpoch}`,
        );
      } else {
        identityStates.add(current.identity.state);
        sideMappings.add(`${current.identity.sideMapping.a}/${current.identity.sideMapping.b}`);
      }
      digestSnapshots(digest, coordinator);
      final = current;
    },
  });
  if (final === undefined) throw new Error('Empty replay');
  return {
    frames: result.acceptedSequences.length,
    accepted: result.acceptedSequences.length,
    digest: digest.digest('hex'),
    finalRuntimeSeq: final.program.cursor.runtimeSeq,
    finalMapName: final.program.map.name,
    finalMapEpoch: final.program.cursor.mapEpoch,
    finalIdentityState: final.identity.state,
    finalIdentitySourceGeneration: final.identity.sourceGeneration,
    finalIdentityMapEpoch: final.identity.mapEpoch,
    identityStates: [...identityStates].sort(),
    sideMappings: [...sideMappings].sort(),
    faultBoundaryStates,
  };
}

describe('完整真实 GSI replay → Companion projection pipeline', () => {
  it.skipIf(fullMatchCaptureDir === undefined)(
    '以确定性时钟两次跑完 16,382 帧并得到相同全链路 digest',
    async () => {
      if (fullMatchCaptureDir === undefined) throw new Error('缺少完整 capture 路径');
      const capture = await verifyCapture(fullMatchCaptureDir);

      expect(capture.manifest.captureId).toBe(FULL_MATCH_CAPTURE_ID);
      expect(capture.manifest.frameCount).toBe(FULL_MATCH_FRAME_COUNT);
      expect(capture.manifest.droppedFrames).toBe(0);
      expect(capture.computedFramesSha256).toBe(FULL_MATCH_FRAMES_SHA256);

      const first = await runPipeline(capture);
      const second = await runPipeline(capture);
      const faultedFirst = await runPipeline(capture, FULL_MATCH_FAULT_PLAN);
      const faultedSecond = await runPipeline(capture, FULL_MATCH_FAULT_PLAN);

      expect(first.frames).toBe(FULL_MATCH_FRAME_COUNT);
      expect(first.accepted).toBe(FULL_MATCH_FRAME_COUNT);
      expect(second).toEqual(first);
      expect(first.faultBoundaryStates).toEqual([]);
      expect(faultedSecond).toEqual(faultedFirst);
      expect(faultedFirst.faultBoundaryStates).toEqual([
        'source-generation-advanced:resolving:resolving:neutral:1:1',
        'map-execution-reset:resolving:resolving:neutral:1:2',
      ]);
      expect(faultedFirst.finalIdentitySourceGeneration).toBe(1);
      expect(faultedFirst.finalIdentityMapEpoch).toBeGreaterThan(first.finalIdentityMapEpoch);
      expect(first.finalRuntimeSeq).toBeGreaterThan(0);
      expect(first.finalMapName).toBe('de_ancient');
      expect(first.finalMapEpoch).toBeGreaterThan(0);
      expect(first.finalIdentityMapEpoch).toBe(first.finalMapEpoch);
      expect(first.finalIdentitySourceGeneration).toBe(0);
      expect(first.identityStates).toContain('matched');
      expect(first.identityStates).not.toContain('mismatch');
      expect(first.sideMappings).toEqual(expect.arrayContaining(['CT/T', 'T/CT']));
    },
    120_000,
  );
});
