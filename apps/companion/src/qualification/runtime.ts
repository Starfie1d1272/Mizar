import type { FastifyInstance } from 'fastify';
import type { ProgramCommitResult, ProgramRuntime } from '../runtime/program-runtime.js';
import type { CaptureRecorder } from '../telemetry/capture-recorder.js';
import {
  registerQualificationRoutes,
  type QualificationControllerOptions,
  type QualificationFinishInput,
} from './controller.js';
import {
  createQualificationEvidenceStore,
  type QualificationClock,
  type QualificationEvidenceStore,
  type QualificationProfile,
} from './evidence.js';

export interface QualificationOptions {
  readonly qualificationMode?: boolean;
  readonly qualificationControlToken?: string;
  readonly qualificationRunId?: string;
  readonly qualificationScenarioPath?: string;
  readonly qualificationHostCheckpointsPath?: string;
  readonly qualificationProfile?: QualificationProfile;
  readonly qualificationClock?: QualificationClock;
  readonly qualificationEvidenceStore?: QualificationEvidenceStore;
  readonly onQualificationRecorderRotate?: (current: CaptureRecorder) => Promise<{
    readonly previousCaptureId: string;
    readonly captureId: string;
    readonly nextRecorder: CaptureRecorder;
  }>;
  readonly onQualificationRestart?: () => void | Promise<void>;
  readonly onQualificationFinish?: (input: QualificationFinishInput) => void | Promise<void>;
}

export function registerQualification(
  app: FastifyInstance,
  options: QualificationOptions,
  dependencies: {
    runtime: ProgramRuntime;
    currentRecorder: () => CaptureRecorder;
    replaceRecorder: (recorder: CaptureRecorder) => void;
    beforeRuntimeMutation: () => void;
    publishRuntimeCommit: (result: ProgramCommitResult) => void;
    recordRuntime: () => void;
    clearCurrentTelemetry: () => void;
    getHostDiagnostics: NonNullable<QualificationControllerOptions['getHostDiagnostics']>;
    getDebugResponse: QualificationControllerOptions['getDebugResponse'];
  },
): void {
  const controlToken = options.qualificationControlToken;
  if (controlToken === undefined || controlToken.trim().length === 0) {
    throw new Error('启用现场验收模式时必须设置现场验收控制令牌。');
  }
  const runId = options.qualificationRunId ?? 'local-qualification';
  const evidence =
    options.qualificationEvidenceStore ??
    createQualificationEvidenceStore({
      runId,
      ...(options.qualificationScenarioPath === undefined
        ? {}
        : { scenarioPath: options.qualificationScenarioPath }),
      ...(options.qualificationHostCheckpointsPath === undefined
        ? {}
        : { hostCheckpointsPath: options.qualificationHostCheckpointsPath }),
      clock: options.qualificationClock ?? {
        now: () => ({ monotonicMs: performance.now(), utc: new Date().toISOString() }),
      },
    });
  const qualificationOptions: QualificationControllerOptions = {
    controlToken,
    runId,
    evidence,
    qualificationProfile: options.qualificationProfile ?? 'base',
    ...(options.qualificationClock === undefined ? {} : { clock: options.qualificationClock }),
    getHostDiagnostics: dependencies.getHostDiagnostics,
    getDebugResponse: dependencies.getDebugResponse,
    programRuntime: dependencies.runtime,
    recorder: dependencies.currentRecorder,
    ...(options.onQualificationRestart === undefined
      ? {}
      : { onRestart: options.onQualificationRestart }),
    ...(options.onQualificationRecorderRotate === undefined
      ? {}
      : {
          rotateRecorder: async () => {
            const previous = dependencies.currentRecorder();
            const result = await options.onQualificationRecorderRotate?.(previous);
            if (result === undefined) throw new Error('采集记录切换回调未配置。');
            const at = options.qualificationClock?.now() ?? {
              monotonicMs: performance.now(),
              utc: new Date().toISOString(),
            };
            dependencies.beforeRuntimeMutation();
            const generationAdvance = dependencies.runtime.advanceProgramSourceGeneration(at);
            if (
              generationAdvance.disposition.kind !== 'accepted' ||
              generationAdvance.disposition.reason !== 'source-generation-advanced'
            ) {
              await result.nextRecorder.finalize();
              throw new Error('接收链路代际推进失败。');
            }
            dependencies.publishRuntimeCommit(generationAdvance);
            dependencies.recordRuntime();
            dependencies.replaceRecorder(result.nextRecorder);
            await previous.finalize();
            return {
              previousCaptureId: result.previousCaptureId,
              captureId: result.captureId,
            };
          },
        }),
    onAcceptedMapReset: (result) => {
      dependencies.beforeRuntimeMutation();
      dependencies.clearCurrentTelemetry();
      dependencies.recordRuntime();
      dependencies.publishRuntimeCommit(result);
    },
    ...(options.onQualificationFinish === undefined
      ? {}
      : { onFinish: options.onQualificationFinish }),
  };
  registerQualificationRoutes(app, qualificationOptions);
}
