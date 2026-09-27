import type { GsiAdaptResult } from '@mizar/telemetry-gsi';

import type { CaptureFrameV1, VerifiedCapture } from '../capture/types.js';

export type ReplayMode =
  { readonly kind: 'step' } | { readonly kind: 'paced'; readonly speed: number };

export interface ReplayScheduler {
  nowMs(): number;
  sleep(delayMs: number, signal?: AbortSignal): Promise<void>;
}

export interface ReplayFaultPlanV1 {
  readonly drop?: readonly number[];
  readonly duplicate?: readonly {
    readonly captureIndex: number;
    readonly copies: number;
  }[];
  readonly reorderAdjacent?: readonly number[];
  readonly timeGap?: readonly {
    readonly afterCaptureIndex: number;
    readonly gapUs: number;
  }[];
  readonly sourceGenerationBoundary?: readonly {
    readonly beforeCaptureIndex: number;
  }[];
}

export interface ReplayCaptureOptions {
  readonly mode: ReplayMode;
  readonly faultPlan?: ReplayFaultPlanV1;
  readonly scheduler?: ReplayScheduler;
  readonly signal?: AbortSignal;
}

export interface ReplayedGsiFrame {
  readonly kind: 'frame';
  readonly captureIndex: number;
  readonly occurrence: number;
  readonly scheduledElapsedUs: number;
  readonly sourceFrame: CaptureFrameV1;
  readonly receiveContext: {
    readonly sequence: number;
    readonly receivedAt: string;
    readonly receivedMonotonicMs: number;
  };
  readonly result: GsiAdaptResult;
}

export interface ReplaySourceGenerationBoundary {
  readonly kind: 'source-generation-boundary';
  readonly generation: number;
  readonly beforeCaptureIndex: number;
  readonly scheduledElapsedUs: number;
}

export type ReplayEvent = ReplayedGsiFrame | ReplaySourceGenerationBoundary;

export type CaptureForReplay = VerifiedCapture;
