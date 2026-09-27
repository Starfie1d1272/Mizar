import { adaptGsiPayload } from '@mizar/telemetry-gsi';

import { CaptureFormatError } from '../capture/errors.js';
import { iterateCaptureFrames } from '../capture/reader.js';
import type { CaptureFrameV1, VerifiedCapture } from '../capture/types.js';
import { ReplayClock } from './clock.js';
import { normalizeFaultPlan, type NormalizedFaultPlan } from './faults.js';
import { realReplayScheduler } from './scheduler.js';
import type {
  ReplayCaptureOptions,
  ReplayEvent,
  ReplayMode,
  ReplaySourceGenerationBoundary,
  ReplayedGsiFrame,
} from './types.js';

function validateMode(mode: ReplayMode): void {
  if (mode.kind === 'step') return;
  if (mode.kind !== 'paced' || !Number.isFinite(mode.speed) || mode.speed <= 0) {
    throw new RangeError('Replay mode speed must be a finite number greater than zero');
  }
}

function shiftedReceivedAt(receivedAt: string, offsetMs: number): string {
  if (offsetMs === 0) return receivedAt;
  const parsed = Date.parse(receivedAt);
  if (!Number.isFinite(parsed)) throw new Error(`Cannot shift invalid receivedAt ${receivedAt}`);
  return new Date(parsed + offsetMs).toISOString();
}

function createGapOffsetReader(plan: NormalizedFaultPlan) {
  let cursor = 0;
  let offsetUs = 0;
  return (slotIndex: number): number => {
    while (cursor < plan.timeGap.length) {
      const gap = plan.timeGap[cursor];
      if (gap === undefined || gap.afterCaptureIndex >= slotIndex) break;
      offsetUs += gap.gapUs;
      cursor += 1;
    }
    return offsetUs;
  };
}

async function nextFrame(
  iterator: AsyncIterator<CaptureFrameV1>,
  expectedIndex: number,
  capture: VerifiedCapture,
): Promise<CaptureFrameV1> {
  const next = await iterator.next();
  if (next.done || next.value === undefined) {
    throw new CaptureFormatError(
      'FRAME_COUNT_MISMATCH',
      `replay ended before captureIndex ${expectedIndex}`,
      { captureId: capture.manifest.captureId, path: capture.framesPath },
    );
  }
  return next.value;
}

export async function* replayCapture(
  capture: VerifiedCapture,
  options: ReplayCaptureOptions,
): AsyncIterable<ReplayEvent> {
  validateMode(options.mode);
  const plan = normalizeFaultPlan(options.faultPlan, capture.manifest.frameCount);
  const scheduler = options.scheduler ?? realReplayScheduler;
  const signal = options.signal;
  const clock = new ReplayClock();
  const gapOffsetForSlot = createGapOffsetReader(plan);
  const frameIterator = iterateCaptureFrames(capture)[Symbol.asyncIterator]();
  const firstElapsedUs = capture.firstElapsedUs;
  const wallStartMs = options.mode.kind === 'paced' ? scheduler.nowMs() : 0;
  let generation = 0;
  let nextCaptureIndex = 0;

  const pace = async (scheduledElapsedUs: number): Promise<boolean> => {
    if (signal?.aborted) return false;
    if (options.mode.kind === 'step') return true;
    const deadlineMs = wallStartMs + scheduledElapsedUs / 1000 / options.mode.speed;
    const delayMs = deadlineMs - scheduler.nowMs();
    if (delayMs <= 0) return !signal?.aborted;
    try {
      await scheduler.sleep(delayMs, signal);
    } catch (error) {
      if (signal?.aborted) return false;
      throw error;
    }
    return !signal?.aborted;
  };

  const emitBoundary = async function* (
    beforeCaptureIndex: number,
    scheduledElapsedUs: number,
  ): AsyncGenerator<ReplaySourceGenerationBoundary> {
    generation += 1;
    if (!(await pace(scheduledElapsedUs))) return;
    clock.advanceTo(scheduledElapsedUs);
    yield {
      kind: 'source-generation-boundary',
      generation,
      beforeCaptureIndex,
      scheduledElapsedUs,
    };
  };

  const emitFrame = async function* (
    sourceFrame: CaptureFrameV1,
    sourceIndex: number,
    slotIndex: number,
    slotElapsedUs: number,
  ): AsyncGenerator<ReplayedGsiFrame> {
    const offsetUs = gapOffsetForSlot(slotIndex);
    const scheduledElapsedUs = slotElapsedUs - firstElapsedUs + offsetUs;
    if (plan.drop.has(sourceIndex)) return;
    const occurrenceCount = (plan.duplicate.get(sourceIndex) ?? 0) + 1;
    for (let occurrence = 0; occurrence < occurrenceCount; occurrence += 1) {
      if (!(await pace(scheduledElapsedUs))) return;
      clock.advanceTo(scheduledElapsedUs);
      const receivedMonotonicMs = (sourceFrame.elapsedUs - firstElapsedUs) / 1000 + offsetUs / 1000;
      const receiveContext = {
        sequence: sourceFrame.sequence,
        receivedAt: shiftedReceivedAt(sourceFrame.receivedAt, offsetUs / 1000),
        receivedMonotonicMs,
      } as const;
      yield {
        kind: 'frame',
        captureIndex: sourceIndex,
        occurrence,
        scheduledElapsedUs,
        sourceFrame,
        receiveContext,
        result: adaptGsiPayload(sourceFrame.payload, receiveContext),
      };
    }
  };

  while (nextCaptureIndex < capture.manifest.frameCount) {
    if (signal?.aborted) return;
    const slotIndex = nextCaptureIndex;
    const firstFrame = await nextFrame(frameIterator, slotIndex, capture);
    if (firstFrame.sequence < 0) throw new Error('unreachable');
    const slotOffsetUs = gapOffsetForSlot(slotIndex);
    const slotElapsedUs = firstFrame.elapsedUs;
    const scheduledBoundaryUs = slotElapsedUs - firstElapsedUs + slotOffsetUs;
    if (plan.sourceGenerationBoundary.has(slotIndex)) {
      yield* emitBoundary(slotIndex, scheduledBoundaryUs);
    }

    if (plan.reorderAdjacent.has(slotIndex)) {
      const secondFrame = await nextFrame(frameIterator, slotIndex + 1, capture);
      yield* emitFrame(secondFrame, slotIndex + 1, slotIndex, slotElapsedUs);
      yield* emitFrame(firstFrame, slotIndex, slotIndex + 1, secondFrame.elapsedUs);
      nextCaptureIndex += 2;
      continue;
    }

    yield* emitFrame(firstFrame, slotIndex, slotIndex, slotElapsedUs);
    nextCaptureIndex += 1;
  }
}
