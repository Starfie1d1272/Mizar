import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { replayCapture } from '../src/replay/runner.js';
import type { CaptureFrameV1 } from '../src/capture/types.js';
import type { ReplayEvent, ReplayScheduler } from '../src/replay/types.js';
import { verifyCapture } from '../src/capture/reader.js';
import { writeCapture, replayPayload, testFrame } from './helpers.js';

type ReplayReceiveContext = {
  readonly sequence: number;
  readonly receivedAt: string;
  readonly receivedMonotonicMs: number;
};

type ProductionAdapter = (
  payload: Record<string, unknown>,
  context: ReplayReceiveContext,
) => unknown;

type TestFrameEvent = {
  readonly kind: 'frame';
  readonly captureIndex: number;
  readonly occurrence: number;
  readonly scheduledElapsedUs: number;
  readonly sourceFrame: CaptureFrameV1;
  readonly receiveContext: ReplayReceiveContext;
  readonly result: unknown;
};

const telemetryGsiPackage = '@mizar/telemetry-gsi';
const productionAdapterModule = (await import(telemetryGsiPackage)) as unknown as {
  readonly adaptGsiPayload: ProductionAdapter;
};
const productionAdapter = productionAdapterModule.adaptGsiPayload;

class ManualScheduler implements ReplayScheduler {
  now = 0;
  readonly sleepCalls: number[] = [];

  constructor(private readonly lagMs = 0) {}

  nowMs(): number {
    return this.now;
  }

  sleep(delayMs: number): Promise<void> {
    this.sleepCalls.push(delayMs);
    this.now += delayMs + this.lagMs;
    return Promise.resolve();
  }
}

async function temporaryDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'rivalhub-testkit-replay-'));
}

async function captureWithFrames(root: string, count = 4) {
  const frames = Array.from({ length: count }, (_, index) =>
    testFrame(index, 1_000_000 + index * 100_000, replayPayload(index)),
  );
  await writeCapture(root, frames);
  return { capture: await verifyCapture(root), frames };
}

async function collect(events: AsyncIterable<ReplayEvent>): Promise<ReplayEvent[]> {
  const output: ReplayEvent[] = [];
  for await (const event of events) output.push(event);
  return output;
}

function frameEvents(events: readonly ReplayEvent[]): TestFrameEvent[] {
  const frames: TestFrameEvent[] = [];
  for (const event of events) {
    if (event.kind !== 'frame') continue;
    frames.push({
      kind: 'frame',
      captureIndex: event.captureIndex,
      occurrence: event.occurrence,
      scheduledElapsedUs: event.scheduledElapsedUs,
      sourceFrame: event.sourceFrame,
      receiveContext: event.receiveContext,
      result: JSON.parse(JSON.stringify(event.result)) as unknown,
    });
  }
  return frames;
}

describe('ReplayClock-backed production adapter replay', () => {
  it('rebases the first elapsedUs to virtual zero and step mode never sleeps', async () => {
    const root = await temporaryDirectory();
    try {
      const { capture } = await captureWithFrames(root, 2);
      const scheduler = new ManualScheduler();
      const iterator = replayCapture(capture, { mode: { kind: 'step' }, scheduler })[
        Symbol.asyncIterator
      ]();

      const first = await iterator.next();
      expect(first.done).toBe(false);
      if (first.done || first.value.kind !== 'frame') return;
      expect(first.value.scheduledElapsedUs).toBe(0);
      expect(scheduler.sleepCalls).toEqual([]);

      const second = await iterator.next();
      expect(second.done).toBe(false);
      if (second.done || second.value.kind !== 'frame') return;
      expect(second.value.scheduledElapsedUs).toBe(100_000);
      expect(scheduler.sleepCalls).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    ['1x', 1, [100, 100]],
    ['8x', 8, [12.5, 12.5]],
  ])('uses absolute deadlines for %s paced replay', async (_label, speed, expectedSleeps) => {
    const root = await temporaryDirectory();
    try {
      const { capture } = await captureWithFrames(root, 3);
      const scheduler = new ManualScheduler();
      const events = await collect(
        replayCapture(capture, {
          mode: { kind: 'paced', speed },
          scheduler,
        }),
      );
      expect(frameEvents(events).map((event) => event.scheduledElapsedUs)).toEqual([
        0, 100_000, 200_000,
      ]);
      expect(scheduler.sleepCalls).toEqual(expectedSleeps);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not accumulate scheduler lag into later absolute deadlines', async () => {
    const root = await temporaryDirectory();
    try {
      const { capture } = await captureWithFrames(root, 3);
      const scheduler = new ManualScheduler(10);
      await collect(
        replayCapture(capture, {
          mode: { kind: 'paced', speed: 1 },
          scheduler,
        }),
      );
      expect(scheduler.sleepCalls).toEqual([100, 90]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps semantic receive context and adapter output equal across step and paced modes', async () => {
    const root = await temporaryDirectory();
    try {
      const { capture } = await captureWithFrames(root, 3);
      const step = frameEvents(await collect(replayCapture(capture, { mode: { kind: 'step' } })));
      const paced = frameEvents(
        await collect(
          replayCapture(capture, {
            mode: { kind: 'paced', speed: 8 },
            scheduler: new ManualScheduler(),
          }),
        ),
      );
      expect(
        paced.map((event) => ({ receiveContext: event.receiveContext, result: event.result })),
      ).toEqual(
        step.map((event) => ({ receiveContext: event.receiveContext, result: event.result })),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('calls the exported production adapter with the same source context', async () => {
    const root = await temporaryDirectory();
    try {
      const { capture, frames } = await captureWithFrames(root, 2);
      const events = frameEvents(await collect(replayCapture(capture, { mode: { kind: 'step' } })));
      for (const event of events) {
        const expected = productionAdapter(event.sourceFrame.payload, event.receiveContext);
        expect(event.result).toEqual(expected);
        expect(event.sourceFrame).toEqual(frames[event.captureIndex]);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('preserves deterministic drop, duplicate, reorder, gap, and generation semantics', async () => {
    const root = await temporaryDirectory();
    try {
      const { capture, frames } = await captureWithFrames(root, 6);
      const events = await collect(
        replayCapture(capture, {
          mode: { kind: 'step' },
          faultPlan: {
            drop: [0],
            duplicate: [{ captureIndex: 1, copies: 2 }],
            reorderAdjacent: [3],
            timeGap: [{ afterCaptureIndex: 1, gapUs: 5_000 }],
            sourceGenerationBoundary: [{ beforeCaptureIndex: 5 }],
          },
        }),
      );
      const frameOutput = frameEvents(events);
      expect(frameOutput.map((event) => event.captureIndex)).toEqual([1, 1, 1, 2, 4, 3, 5]);
      expect(frameOutput.slice(0, 3).map((event) => event.occurrence)).toEqual([0, 1, 2]);
      expect(frameOutput[0]?.sourceFrame).toEqual(frames[1]);
      expect(frameOutput[0]?.sourceFrame).toEqual(frameOutput[1]?.sourceFrame);
      expect(frameOutput[0]?.receiveContext).toEqual(frameOutput[1]?.receiveContext);
      expect(frameOutput[0]?.scheduledElapsedUs).toBe(frameOutput[1]?.scheduledElapsedUs);
      expect(frameOutput[3]?.scheduledElapsedUs).toBe(205_000);
      expect(frameOutput[4]?.captureIndex).toBe(4);
      expect(frameOutput[5]?.captureIndex).toBe(3);
      expect(frameOutput[4]?.sourceFrame).toEqual(frames[4]);
      expect(frameOutput[5]?.sourceFrame).toEqual(frames[3]);
      expect(frameOutput[6]?.scheduledElapsedUs).toBe(505_000);
      expect(frameOutput[6]?.receiveContext.receivedAt).toBe('2026-09-14T00:00:05.005Z');
      expect(frameOutput[6]?.sourceFrame.receivedAt).toBe('2026-09-14T00:00:05.000Z');
      expect(events.filter((event) => event.kind === 'source-generation-boundary')).toEqual([
        {
          kind: 'source-generation-boundary',
          generation: 1,
          beforeCaptureIndex: 5,
          scheduledElapsedUs: 505_000,
        },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('stops future emission when AbortSignal is aborted', async () => {
    const root = await temporaryDirectory();
    try {
      const { capture } = await captureWithFrames(root, 3);
      const controller = new AbortController();
      const iterator = replayCapture(capture, {
        mode: { kind: 'step' },
        signal: controller.signal,
      })[Symbol.asyncIterator]();
      const first = await iterator.next();
      expect(first.done).toBe(false);
      controller.abort();
      expect((await iterator.next()).done).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
