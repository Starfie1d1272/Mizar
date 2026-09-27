import { readFileSync } from 'node:fs';
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { RuntimeTime } from '@mizar/core/runtime';

import type { LocalWebChannel } from '../local-web/transport-constants.js';
import type { LocalWebHostEvent, LocalWebHostKind } from '../local-web/websocket-transport.js';
import type { ProgramRuntimeSnapshot } from '../runtime/program-runtime.js';
import qualificationContractJson from './contract.json' with { type: 'json' };

type QualificationContract = {
  readonly schemaVersion: 1;
  readonly maxMarkers: 128;
  readonly nodeRuntimeVersion: `v24.${number}.${number}`;
  readonly markerKinds: readonly QualificationMarkerKind[];
  readonly objectiveScenarioMarkerKinds: readonly QualificationMarkerKind[];
  readonly liveMarkerKinds: readonly QualificationMarkerKind[];
  readonly markerPhases: readonly QualificationMarkerPhase[];
  readonly freshnessValues: readonly QualificationFreshness[];
  readonly resultValues: readonly QualificationResult[];
  readonly checkKeys: readonly QualificationCheckKey[];
  readonly resetDispositionValues: readonly QualificationResetDisposition[];
  readonly resetEvidenceFields: readonly QualificationResetEvidenceField[];
  readonly resetKind: 'map-execution-reset';
  readonly resetReason: 'operator-correction';
  readonly qualificationProfiles: readonly QualificationProfile[];
  readonly hostCheckpointSchemaVersion: 1;
  readonly hostScenarios: readonly HostCheckpointScenario[];
  readonly restartRequestExitCode: 75;
  readonly releaseCheckKeys: readonly ReleaseCheckKey[];
};

export type QualificationProfile = 'base' | 'objective-timing' | 'release';

export type HostCheckpointScenario =
  'browser-reload' | 'obs-reload' | 'scene-visibility' | 'companion-restart';

export type HostCheckpointPhase = 'before' | 'after';

export type ReleaseCheckKey =
  'browserReload' | 'obsReload' | 'sceneVisibility' | 'companionRestart';

export interface HostCheckpointIdentity {
  readonly runId: string;
  readonly gitSha?: string;
  readonly artifactSha256?: string;
}

export interface HostCheckpointRuntimeSnapshot {
  readonly producerInstanceId: string;
  readonly freshness: QualificationFreshness;
  readonly mapEpoch: number;
  readonly sourceGeneration: number;
  readonly runtimeSeq: number;
}

export interface HostCheckpointHostSnapshot {
  readonly active: {
    readonly obs: number;
    readonly browser: number;
    readonly unknown: number;
  };
  readonly byHostChannel: Readonly<
    Record<LocalWebHostKind, Readonly<Record<LocalWebChannel, number>>>
  >;
  readonly obsVersions: readonly string[];
  readonly recentEvents: readonly LocalWebHostEvent[];
}

export interface HostCheckpoint {
  readonly schemaVersion: 1;
  readonly scenario: HostCheckpointScenario;
  readonly phase: HostCheckpointPhase;
  readonly timestamp: {
    readonly monotonicMs: number;
    readonly utc: string;
  };
  readonly identity: HostCheckpointIdentity;
  readonly runtime: HostCheckpointRuntimeSnapshot;
  readonly host: HostCheckpointHostSnapshot;
  readonly programVisible?: boolean;
}

// Objective scenario markers use phase=before/after to bind operator intent to
// the exact capture window that the offline analyzer must verify.
export type QualificationObjectiveScenarioMarkerKind =
  | 'objective-freezetime-live'
  | 'objective-plant-abort'
  | 'objective-planted-explode'
  | 'objective-defuse-kit-abort-restart'
  | 'objective-defuse-no-kit-abort-restart'
  | 'objective-too-late-defuse'
  | 'objective-fast-defuse-missing-planted-sample'
  | 'objective-reconnect-restart';

export type QualificationMarkerKind =
  | 'demo-a-live'
  | 'cs2-closed'
  | 'runtime-stale'
  | 'next-execution'
  | 'cs2-reopened'
  | 'demo-b-live'
  | QualificationObjectiveScenarioMarkerKind;

export type QualificationMarkerPhase = 'before' | 'after';
export type QualificationFreshness = 'awaiting' | 'fresh' | 'stale';
export type QualificationResult = 'PASS' | 'FAIL' | 'INCONCLUSIVE';
export type QualificationCheckKey =
  | 'productionChain'
  | 'realSilenceToStale'
  | 'explicitNextExecution'
  | 'demoBRecovery'
  | 'captureIntegrity';
export type QualificationResetDisposition = 'accepted' | 'ignored';
export type QualificationResetEvidenceField =
  | 'disposition'
  | 'reason'
  | 'resetReason'
  | 'previousMapEpoch'
  | 'mapEpoch'
  | 'programTelemetryCleared';

const qualificationContract = qualificationContractJson as QualificationContract;

export const QUALIFICATION_SCHEMA_VERSION = qualificationContract.schemaVersion;
export const QUALIFICATION_MAX_MARKERS = qualificationContract.maxMarkers;
export const QUALIFICATION_MARKER_KINDS = qualificationContract.markerKinds;
export const QUALIFICATION_OBJECTIVE_SCENARIO_MARKER_KINDS =
  qualificationContract.objectiveScenarioMarkerKinds;
export const QUALIFICATION_LIVE_MARKER_KINDS = qualificationContract.liveMarkerKinds;
export const QUALIFICATION_FRESHNESS_VALUES = qualificationContract.freshnessValues;
export const QUALIFICATION_RESULT_VALUES = qualificationContract.resultValues;
export const QUALIFICATION_CHECK_KEYS = qualificationContract.checkKeys;
export const QUALIFICATION_RESET_EVIDENCE_FIELDS = qualificationContract.resetEvidenceFields;
export const QUALIFICATION_RESET_KIND = qualificationContract.resetKind;
export const QUALIFICATION_RESET_REASON = qualificationContract.resetReason;
export const QUALIFICATION_PROFILES = qualificationContract.qualificationProfiles;
export const HOST_CHECKPOINT_SCHEMA_VERSION = qualificationContract.hostCheckpointSchemaVersion;
export const HOST_SCENARIOS = qualificationContract.hostScenarios;
export const RESTART_REQUEST_EXIT_CODE = qualificationContract.restartRequestExitCode;
export const RELEASE_CHECK_KEYS = qualificationContract.releaseCheckKeys;

export interface QualificationClock {
  now(): RuntimeTime;
}

export interface QualificationResetEvidence {
  readonly disposition: 'accepted' | 'ignored';
  readonly reason: 'map-execution-reset';
  readonly resetReason: 'operator-correction';
  readonly previousMapEpoch: number;
  readonly mapEpoch: number;
  readonly programTelemetryCleared: boolean;
}

export interface QualificationAcceptedObservation {
  readonly sequence: number;
  readonly receivedAt: string;
  readonly receivedMonotonicMs: number;
  readonly producerInstanceId: string;
  readonly sourceGeneration: number;
  readonly mapEpoch: number;
  readonly runtimeSeq: number;
  readonly freshness: QualificationFreshness;
}

export interface QualificationMarker {
  readonly schemaVersion: typeof QUALIFICATION_SCHEMA_VERSION;
  readonly runId: string;
  readonly kind: QualificationMarkerKind;
  readonly monotonicMs: number;
  readonly wallClockAt: string;
  readonly producerInstanceId: string;
  readonly mapEpoch: number;
  readonly runtimeSeq: number;
  readonly sourceGeneration: number;
  readonly freshness: QualificationFreshness;
  readonly observation: QualificationAcceptedObservation | null;
  readonly captureId?: string;
  readonly captureElapsedUs?: number;
  readonly phase?: QualificationMarkerPhase;
  readonly reset?: QualificationResetEvidence;
}

export interface QualificationEvidenceStoreOptions {
  readonly runId: string;
  readonly scenarioPath?: string;
  readonly hostCheckpointsPath?: string;
  readonly clock: QualificationClock;
  readonly maxMarkers?: number;
  readonly maxHostCheckpoints?: number;
  readonly gitSha?: string;
  readonly artifactSha256?: string;
}

export interface QualificationEvidenceSnapshot {
  readonly markers: readonly QualificationMarker[];
  readonly lastMarker: QualificationMarker | null;
  readonly scenarioWriteFailed: boolean;
  readonly hostCheckpoints: readonly HostCheckpoint[];
  readonly hostCheckpointsWriteFailed: boolean;
}

function isQualificationMarkerKind(value: unknown): value is QualificationMarkerKind {
  return typeof value === 'string' && QUALIFICATION_MARKER_KINDS.some((kind) => kind === value);
}

function isHostCheckpointScenario(value: unknown): value is HostCheckpointScenario {
  return typeof value === 'string' && HOST_SCENARIOS.some((scenario) => scenario === value);
}

function isObjectiveScenarioMarkerKind(
  value: QualificationMarkerKind,
): value is QualificationObjectiveScenarioMarkerKind {
  return QUALIFICATION_OBJECTIVE_SCENARIO_MARKER_KINDS.some((kind) => kind === value);
}

function assertFiniteRuntimeTime(at: RuntimeTime): void {
  if (!Number.isFinite(at.monotonicMs)) {
    throw new RangeError('现场验收时钟必须返回有限的单调时间戳。');
  }
  if (typeof at.utc !== 'string' || at.utc.length === 0) {
    throw new RangeError('现场验收时钟必须返回非空的 UTC 时间戳。');
  }
}

function acceptedObservationFrom(
  snapshot: ProgramRuntimeSnapshot,
  freshness: QualificationFreshness,
): QualificationAcceptedObservation | null {
  const accepted = snapshot.current.programSource.lastAccepted;
  if (accepted === undefined) return null;
  return {
    sequence: accepted.sequence,
    receivedAt: accepted.receivedAt,
    receivedMonotonicMs: accepted.receivedMonotonicMs,
    producerInstanceId: snapshot.producerInstanceId,
    sourceGeneration: snapshot.current.programSource.generation,
    mapEpoch: snapshot.current.map.epoch,
    runtimeSeq: snapshot.current.runtimeSeq,
    freshness,
  };
}

export class QualificationEvidenceStore {
  private readonly runId: string;
  private readonly scenarioPath: string | undefined;
  private readonly hostCheckpointsPath: string | undefined;
  private readonly clock: QualificationClock;
  private readonly maxMarkers: number;
  private readonly maxHostCheckpoints: number;
  private readonly gitSha: string | undefined;
  private readonly artifactSha256: string | undefined;
  private readonly markers: QualificationMarker[] = [];
  private readonly hostCheckpoints: HostCheckpoint[] = [];
  private writeChain: Promise<void> = Promise.resolve();
  private hostCheckpointsWriteChain: Promise<void> = Promise.resolve();
  private lastFreshness: QualificationFreshness | undefined;
  private scenarioWriteFailed = false;
  private hostCheckpointsWriteFailed = false;

  constructor(options: QualificationEvidenceStoreOptions) {
    if (options.runId.trim().length === 0) throw new Error('现场验收轮次编号不能为空。');
    if (
      options.maxMarkers !== undefined &&
      (!Number.isSafeInteger(options.maxMarkers) ||
        options.maxMarkers <= 0 ||
        options.maxMarkers > QUALIFICATION_MAX_MARKERS)
    ) {
      throw new RangeError(`现场验收标记数量上限必须在 1 到 ${QUALIFICATION_MAX_MARKERS} 之间`);
    }
    this.runId = options.runId;
    this.scenarioPath = options.scenarioPath;
    this.hostCheckpointsPath = options.hostCheckpointsPath;
    this.clock = options.clock;
    this.maxMarkers = options.maxMarkers ?? QUALIFICATION_MAX_MARKERS;
    this.maxHostCheckpoints = options.maxHostCheckpoints ?? QUALIFICATION_MAX_MARKERS;
    this.gitSha = options.gitSha;
    this.artifactSha256 = options.artifactSha256;

    if (this.scenarioPath !== undefined) {
      try {
        const text = readFileSync(this.scenarioPath, 'utf8');
        for (const line of text.split('\n')) {
          const trimmed = line.trim();
          if (trimmed.length === 0) continue;
          const parsed = JSON.parse(trimmed) as QualificationMarker;
          if (isQualificationMarkerKind(parsed.kind)) {
            this.markers.push(parsed);
          }
        }
      } catch {
        // file doesn't exist yet or is unreadable
      }
    }

    if (this.hostCheckpointsPath !== undefined) {
      try {
        const text = readFileSync(this.hostCheckpointsPath, 'utf8');
        for (const line of text.split('\n')) {
          const trimmed = line.trim();
          if (trimmed.length === 0) continue;
          const parsed = JSON.parse(trimmed) as HostCheckpoint;
          if (parsed.schemaVersion === 1 && isHostCheckpointScenario(parsed.scenario)) {
            this.hostCheckpoints.push(parsed);
          }
        }
      } catch {
        // file doesn't exist yet or is unreadable
      }
    }
  }

  async recordMarker(
    kind: QualificationMarkerKind,
    snapshot: ProgramRuntimeSnapshot,
    freshness: QualificationFreshness,
    options: {
      readonly phase?: QualificationMarkerPhase;
      readonly reset?: QualificationResetEvidence;
      readonly captureId?: string;
      readonly captureElapsedUs?: number;
    } = {},
  ): Promise<QualificationMarker> {
    if (!isQualificationMarkerKind(kind)) {
      throw new Error(`不支持的现场验收场景标记：${String(kind)}`);
    }
    const at = this.clock.now();
    assertFiniteRuntimeTime(at);
    const observation = acceptedObservationFrom(snapshot, freshness);
    if (isObjectiveScenarioMarkerKind(kind)) {
      if (
        options.phase === undefined ||
        options.captureId === undefined ||
        options.captureId.trim().length === 0 ||
        options.captureElapsedUs === undefined ||
        !Number.isSafeInteger(options.captureElapsedUs) ||
        options.captureElapsedUs < 0
      ) {
        throw new Error(`${kind} 需要采集记录编号、采集时间以及“开始/结束”阶段。`);
      }
    }
    if (
      QUALIFICATION_LIVE_MARKER_KINDS.includes(kind) &&
      (freshness !== 'fresh' || observation === null)
    ) {
      throw new Error(`${kind} 需要数据正常时的已接收观测。`);
    }
    const marker: QualificationMarker = {
      schemaVersion: QUALIFICATION_SCHEMA_VERSION,
      runId: this.runId,
      kind,
      monotonicMs: at.monotonicMs,
      wallClockAt: at.utc,
      producerInstanceId: snapshot.producerInstanceId,
      mapEpoch: snapshot.current.map.epoch,
      runtimeSeq: snapshot.current.runtimeSeq,
      sourceGeneration: snapshot.current.programSource.generation,
      freshness,
      observation,
      ...(options.captureId === undefined ? {} : { captureId: options.captureId }),
      ...(options.captureElapsedUs === undefined
        ? {}
        : { captureElapsedUs: options.captureElapsedUs }),
      ...(options.phase === undefined ? {} : { phase: options.phase }),
      ...(options.reset === undefined ? {} : { reset: options.reset }),
    };

    const write = this.writeChain.then(async () => {
      if (this.scenarioPath === undefined) return;
      await mkdir(dirname(this.scenarioPath), { recursive: true });
      await appendFile(this.scenarioPath, `${JSON.stringify(marker)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      });
    });
    this.writeChain = write.catch(() => undefined);
    try {
      await write;
    } catch (error) {
      this.scenarioWriteFailed = true;
      throw error;
    }

    this.markers.push(marker);
    const overflow = this.markers.length - this.maxMarkers;
    if (overflow > 0) this.markers.splice(0, overflow);
    return marker;
  }

  async recordHostCheckpoint(options: {
    readonly scenario: HostCheckpointScenario;
    readonly phase: HostCheckpointPhase;
    readonly runtime: HostCheckpointRuntimeSnapshot;
    readonly host: HostCheckpointHostSnapshot;
    readonly programVisible?: boolean;
    readonly at?: RuntimeTime;
  }): Promise<HostCheckpoint> {
    if (!isHostCheckpointScenario(options.scenario)) {
      throw new Error(`不支持的 Host 场景：${String(options.scenario)}`);
    }
    if (options.phase !== 'before' && options.phase !== 'after') {
      throw new Error(`不支持的 Host 检查点阶段：${String(options.phase)}`);
    }
    const at = options.at ?? this.clock.now();
    assertFiniteRuntimeTime(at);

    const checkpoint: HostCheckpoint = {
      schemaVersion: 1,
      scenario: options.scenario,
      phase: options.phase,
      timestamp: {
        monotonicMs: at.monotonicMs,
        utc: at.utc,
      },
      identity: {
        runId: this.runId,
        ...(this.gitSha === undefined ? {} : { gitSha: this.gitSha }),
        ...(this.artifactSha256 === undefined ? {} : { artifactSha256: this.artifactSha256 }),
      },
      runtime: options.runtime,
      host: options.host,
      ...(options.programVisible === undefined ? {} : { programVisible: options.programVisible }),
    };

    const write = this.hostCheckpointsWriteChain.then(async () => {
      if (this.hostCheckpointsPath === undefined) return;
      await mkdir(dirname(this.hostCheckpointsPath), { recursive: true });
      await appendFile(this.hostCheckpointsPath, `${JSON.stringify(checkpoint)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      });
    });
    this.hostCheckpointsWriteChain = write.catch(() => undefined);
    try {
      await write;
    } catch (error) {
      this.hostCheckpointsWriteFailed = true;
      throw error;
    }

    this.hostCheckpoints.push(checkpoint);
    const overflow = this.hostCheckpoints.length - this.maxHostCheckpoints;
    if (overflow > 0) this.hostCheckpoints.splice(0, overflow);
    return checkpoint;
  }

  async observeFreshness(
    freshness: QualificationFreshness,
    snapshot: ProgramRuntimeSnapshot,
  ): Promise<void> {
    if (freshness === 'stale' && this.lastFreshness !== 'stale') {
      await this.recordMarker('runtime-stale', snapshot, freshness);
    }
    this.lastFreshness = freshness;
  }

  getSnapshot(): QualificationEvidenceSnapshot {
    const markers = this.markers.slice();
    return {
      markers,
      lastMarker: markers.at(-1) ?? null,
      scenarioWriteFailed: this.scenarioWriteFailed,
      hostCheckpoints: this.hostCheckpoints.slice(),
      hostCheckpointsWriteFailed: this.hostCheckpointsWriteFailed,
    };
  }
}

export function createQualificationEvidenceStore(
  options: QualificationEvidenceStoreOptions,
): QualificationEvidenceStore {
  return new QualificationEvidenceStore(options);
}
