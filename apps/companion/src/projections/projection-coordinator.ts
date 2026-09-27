import {
  emptyActiveLineup,
  identityEvidenceFromObservation,
  createIdentityResolver,
  resolveActiveLineup,
  type ActiveLineupOverride,
  type ActiveLineupResolution,
  type IdentityResolution,
  type IdentityResolver,
} from '@rivalhub-broadcast/core/identity';
import {
  projectObserverAssist,
  inspectBp,
  projectProgram,
  selectProgramSafeRuntimeView,
  type ObserverAssistProjection,
  type ProgramProjection,
} from '@rivalhub-broadcast/core/projection';
import type { OperatorCommand, SeriesSideProof } from '@rivalhub-broadcast/core/series-progress';
import {
  getObjectiveClockLeaseMs,
  type RuntimeReduceResult,
} from '@rivalhub-broadcast/core/runtime';
import { assistSnapshotSchema, type AssistSnapshot } from '@rivalhub-broadcast/protocol/assist';
import {
  operatorSnapshotSchema,
  type OperatorSnapshot,
} from '@rivalhub-broadcast/protocol/operator';
import { programSnapshotSchema, type ProgramSnapshot } from '@rivalhub-broadcast/protocol/program';
import { radarSnapshotSchema, type RadarSnapshot } from '@rivalhub-broadcast/protocol/radar';
import {
  ASSIST_SCHEMA_VERSION,
  LOCAL_PROTOCOL_VERSION,
  OPERATOR_SCHEMA_VERSION,
  PROGRAM_SCHEMA_VERSION,
  RADAR_SCHEMA_VERSION,
} from '@rivalhub-broadcast/protocol/version';
import { projectRadarFrame, type RadarFrame } from '@rivalhub-broadcast/radar';

import type { MatchContextBinding } from '../match-context/index.js';
import type { MatchContext } from '@rivalhub-broadcast/core/match-context';
import type { CstvSourceManagers } from '../telemetry/cstv-source-manager.js';
import type { ProgramRuntime, SeriesOperatorCommandResult } from '../runtime/program-runtime.js';
import {
  createLocalChannelPublisher,
  type LocalChannelPublisher,
} from '../local-protocol/channel-publisher.js';
import { mapObserverAssistProjection } from '../local-protocol/assist-wire.js';
import { mapOperatorProjection } from '../local-protocol/operator-wire.js';
import { mapProgramProjection } from '../local-protocol/program-wire.js';
import { mapRadarFrame } from '../local-protocol/radar-wire.js';
import { projectOperator, type OperatorProjection } from './operator-projection.js';

export interface ProjectionBundle {
  readonly program: ProgramProjection;
  readonly radar: RadarFrame;
  readonly operator: OperatorProjection;
  readonly assist: ObserverAssistProjection;
  readonly identity: IdentityResolution;
}

export interface ProjectionPublishers {
  readonly program?: LocalChannelPublisher<ProgramSnapshot>;
  readonly radar?: LocalChannelPublisher<RadarSnapshot>;
  readonly operator?: LocalChannelPublisher<OperatorSnapshot>;
  readonly assist?: LocalChannelPublisher<AssistSnapshot>;
}

export interface ProjectionCoordinatorOptions {
  readonly programRuntime: ProgramRuntime;
  readonly cstvSources: CstvSourceManagers;
  readonly identityResolver?: IdentityResolver;
  readonly activeLineupOverride?: ActiveLineupOverride;
  readonly matchContextBinding?: MatchContextBinding;
  readonly nowMonotonicMs?: () => number;
  readonly scheduler?: ProjectionScheduler;
  readonly publishers?: ProjectionPublishers;
  readonly onDiagnostic?: (diagnostic: { readonly code: string }) => void;
}

export interface ProjectionScheduler {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

const defaultNowMonotonicMs = (): number => globalThis.performance.now();
const defaultScheduler: ProjectionScheduler = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

function defaultPublishers(
  onDiagnostic: ((diagnostic: { readonly code: string }) => void) | undefined,
): Required<ProjectionPublishers> {
  const diagnosticOption = (channel: string) =>
    onDiagnostic === undefined
      ? {}
      : {
          onDiagnostic: (diagnostic: { readonly code: string }) =>
            onDiagnostic({ code: `${channel}-${diagnostic.code}` }),
        };
  return {
    program: createLocalChannelPublisher({
      id: 'program',
      schema: programSnapshotSchema,
      ...diagnosticOption('program'),
    }),
    radar: createLocalChannelPublisher({
      id: 'radar',
      schema: radarSnapshotSchema,
      ...diagnosticOption('radar'),
    }),
    operator: createLocalChannelPublisher({
      id: 'operator',
      schema: operatorSnapshotSchema,
      ...diagnosticOption('operator'),
    }),
    assist: createLocalChannelPublisher({
      id: 'assist',
      schema: assistSnapshotSchema,
      ...diagnosticOption('assist'),
    }),
  };
}

function mergePublishers(
  publishers: ProjectionPublishers | undefined,
  onDiagnostic: ((diagnostic: { readonly code: string }) => void) | undefined,
): Required<ProjectionPublishers> {
  const defaults = defaultPublishers(onDiagnostic);
  return {
    program: publishers?.program ?? defaults.program,
    radar: publishers?.radar ?? defaults.radar,
    operator: publishers?.operator ?? defaults.operator,
    assist: publishers?.assist ?? defaults.assist,
  };
}

function report(
  onDiagnostic: ((diagnostic: { readonly code: string }) => void) | undefined,
  code: string,
): void {
  try {
    onDiagnostic?.({ code });
  } catch {
    // Projection diagnostics must not interrupt the Runtime mutation path.
  }
}

export class ProjectionCoordinator {
  private readonly programRuntime: ProgramRuntime;
  private readonly cstvSources: CstvSourceManagers;
  private readonly identityResolver: IdentityResolver;
  private readonly activeLineupOverride: ActiveLineupOverride | undefined;
  private readonly nowMonotonicMs: () => number;
  private readonly scheduler: ProjectionScheduler;
  private readonly publishers: Required<ProjectionPublishers>;
  private readonly onDiagnostic: ((diagnostic: { readonly code: string }) => void) | undefined;
  private readonly sourceUnsubscribers: readonly (() => void)[];
  private contextBinding: MatchContextBinding | undefined;
  private boundContext: MatchContext | undefined;
  private boundMatchId: string | undefined;
  private lastIdentityEvidence:
    { readonly sourceGeneration: number; readonly receiveSequence: number } | undefined;
  private current: ProjectionBundle;
  private activeLineup: ActiveLineupResolution;
  private staleTimer: unknown;
  private staleTimerKey:
    { readonly sourceGeneration: number; readonly receiveSequence: number } | undefined;
  private staleDeadline: number | undefined;
  private stalePublishedKey:
    { readonly sourceGeneration: number; readonly receiveSequence: number } | undefined;
  private staleSuppressedUntilNewFrame = false;
  private refreshing = false;
  private closed = false;

  constructor(options: ProjectionCoordinatorOptions) {
    this.programRuntime = options.programRuntime;
    this.cstvSources = options.cstvSources;
    this.identityResolver = options.identityResolver ?? createIdentityResolver();
    this.activeLineupOverride = options.activeLineupOverride;
    this.nowMonotonicMs = options.nowMonotonicMs ?? defaultNowMonotonicMs;
    this.scheduler = options.scheduler ?? defaultScheduler;
    this.onDiagnostic = options.onDiagnostic;
    this.publishers = mergePublishers(options.publishers, options.onDiagnostic);
    this.contextBinding = options.matchContextBinding;
    if (this.contextBinding !== undefined) {
      this.boundContext = this.contextBinding.context;
      this.identityResolver.bind(this.contextBinding.context);
      this.boundMatchId = this.contextBinding.context.matchId;
    }
    this.activeLineup = emptyActiveLineup();
    this.current = this.refresh();
    this.sourceUnsubscribers = [
      this.cstvSources.program.subscribe(() => this.refreshOperator()),
      this.cstvSources.lookahead.subscribe(() => this.refreshOperator()),
    ];
  }

  setMatchContextBinding(binding: MatchContextBinding | undefined): ProjectionBundle {
    if (this.closed) return this.current;
    this.contextBinding = binding;
    if (binding === undefined) {
      this.boundContext = undefined;
      this.boundMatchId = undefined;
      this.lastIdentityEvidence = undefined;
      this.identityResolver.unbind();
      this.activeLineup = emptyActiveLineup(
        this.programRuntime.getSnapshot().current.programSource.generation,
        this.programRuntime.getSnapshot().current.map.epoch,
      );
    } else {
      const matchChanged =
        this.boundMatchId !== undefined && this.boundMatchId !== binding.context.matchId;
      const contextChanged =
        this.boundContext !== binding.context || this.boundMatchId !== binding.context.matchId;
      this.boundContext = binding.context;
      this.boundMatchId = binding.context.matchId;
      if (contextChanged) {
        this.identityResolver.bind(binding.context);
        this.lastIdentityEvidence = undefined;
        if (matchChanged) {
          const runtime = this.programRuntime.getSnapshot().current;
          this.activeLineup = emptyActiveLineup(
            runtime.programSource.generation,
            runtime.map.epoch,
          );
        }
      }
    }
    return this.refresh();
  }

  afterRuntimeMutation(result?: RuntimeReduceResult): ProjectionBundle {
    if (this.closed) return this.current;
    if (result !== undefined) {
      if (result.disposition.kind !== 'accepted') return this.current;
      if (
        result.disposition.reason === 'map-execution-reset' ||
        result.disposition.reason === 'source-generation-advanced'
      ) {
        this.cancelStaleTimer();
        this.stalePublishedKey = undefined;
        this.staleSuppressedUntilNewFrame = true;
      } else {
        this.staleSuppressedUntilNewFrame = false;
      }
    }
    return this.refresh();
  }

  refresh(): ProjectionBundle {
    if (this.closed || this.refreshing) return this.current;
    this.refreshing = true;
    try {
      const runtimeSnapshot = this.programRuntime.getSnapshot();
      const runtimeState = runtimeSnapshot.current;
      const runtimeView = selectProgramSafeRuntimeView(runtimeState);
      const identity = this.resolveIdentity(runtimeSnapshot);
      const activeLineup = this.resolveActiveLineup(runtimeSnapshot, identity);
      const context = this.contextBinding?.context;
      const seriesProgress = this.programRuntime.synchronizeSeriesProgress(
        context,
        seriesSideProofFor(runtimeSnapshot, identity),
      );
      const nowMonotonicMs = this.nowMonotonicMs();
      const program = projectProgram({
        runtime: runtimeView,
        ...(context === undefined ? {} : { context }),
        ...(this.contextBinding === undefined
          ? {}
          : { contextFreshness: this.contextBinding.freshness }),
        identity,
        activeLineup,
        seriesProgress,
        nowMonotonicMs,
        continuityPolicy: runtimeSnapshot.continuityPolicy,
      });
      const radar = projectRadarFrame({
        runtime: runtimeView,
        identity,
        nowMonotonicMs,
        continuityPolicy: runtimeSnapshot.continuityPolicy,
      });
      const operator = projectOperator({
        runtime: runtimeSnapshot,
        context: this.contextBinding,
        identity,
        activeLineup,
        cstvSources: this.cstvSources,
        nowMonotonicMs,
      });
      const assist = projectObserverAssist(runtimeView);
      this.current = { program, radar, operator, assist, identity };
      this.publish(program, radar, operator, assist);
      this.scheduleStaleDeadline(
        runtimeView,
        program,
        nowMonotonicMs,
        runtimeSnapshot.continuityPolicy,
      );
      return this.current;
    } finally {
      this.refreshing = false;
    }
  }

  getBpProjection() {
    return this.getBpAssessment().projection;
  }

  getBpAssessment() {
    if (this.getCurrent().identity.state === 'mismatch')
      return { readiness: 'conflict' as const, projection: null };
    return inspectBp(this.contextBinding?.context);
  }

  getCurrent(): ProjectionBundle {
    return this.current;
  }

  executeOperatorCommand(command: OperatorCommand): SeriesOperatorCommandResult {
    const result = this.programRuntime.executeOperatorCommand(command);
    if (!this.closed) this.refresh();
    return result;
  }

  getPublisher(channel: 'program'): LocalChannelPublisher<ProgramSnapshot>;
  getPublisher(channel: 'radar'): LocalChannelPublisher<RadarSnapshot>;
  getPublisher(channel: 'operator'): LocalChannelPublisher<OperatorSnapshot>;
  getPublisher(channel: 'assist'): LocalChannelPublisher<AssistSnapshot>;
  getPublisher(
    channel: keyof ProjectionPublishers,
  ):
    | LocalChannelPublisher<ProgramSnapshot>
    | LocalChannelPublisher<RadarSnapshot>
    | LocalChannelPublisher<OperatorSnapshot>
    | LocalChannelPublisher<AssistSnapshot>;
  getPublisher(
    channel: keyof ProjectionPublishers,
  ): LocalChannelPublisher<ProgramSnapshot | RadarSnapshot | OperatorSnapshot | AssistSnapshot> {
    return this.publishers[channel];
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.cancelStaleTimer();
    for (const unsubscribe of this.sourceUnsubscribers) unsubscribe();
    await Promise.all([
      this.publishers.program.close(),
      this.publishers.radar.close(),
      this.publishers.operator.close(),
      this.publishers.assist.close(),
    ]);
  }

  private resolveIdentity(
    runtimeSnapshot: ReturnType<ProgramRuntime['getSnapshot']>,
  ): IdentityResolution {
    if (this.contextBinding === undefined) {
      this.boundContext = undefined;
      this.boundMatchId = undefined;
      return this.identityResolver.unbind();
    }

    if (
      this.boundContext !== this.contextBinding.context ||
      this.boundMatchId !== this.contextBinding.context.matchId
    ) {
      this.identityResolver.bind(this.contextBinding.context);
      this.boundContext = this.contextBinding.context;
      this.boundMatchId = this.contextBinding.context.matchId;
      this.lastIdentityEvidence = undefined;
    }

    const observation = runtimeSnapshot.current.programTelemetry;
    const cursor = runtimeSnapshot.current.programSource.lastAccepted;
    const currentGeneration = runtimeSnapshot.current.programSource.generation;
    const currentReceiveSequence =
      cursor?.generation === currentGeneration ? cursor.sequence : undefined;
    if (
      observation === undefined ||
      cursor === undefined ||
      cursor.generation !== currentGeneration
    ) {
      this.identityResolver.bind(this.contextBinding.context);
      return this.identityResolver.getResolution();
    }

    const currentResolution = this.identityResolver.getResolution();
    const evidenceIsNew =
      currentReceiveSequence !== undefined &&
      (this.lastIdentityEvidence === undefined ||
        this.lastIdentityEvidence.sourceGeneration !== currentGeneration ||
        this.lastIdentityEvidence.receiveSequence !== currentReceiveSequence);
    if (
      (currentResolution.sourceGeneration !== currentGeneration ||
        currentResolution.mapEpoch !== runtimeSnapshot.current.map.epoch) &&
      !evidenceIsNew
    ) {
      this.identityResolver.bind(this.contextBinding.context);
      return this.identityResolver.getResolution();
    }

    const resolution = this.identityResolver.resolve(
      identityEvidenceFromObservation(
        observation,
        currentGeneration,
        runtimeSnapshot.current.map.epoch,
      ),
    );
    if (currentReceiveSequence !== undefined) {
      this.lastIdentityEvidence = {
        sourceGeneration: currentGeneration,
        receiveSequence: currentReceiveSequence,
      };
    }
    return resolution;
  }

  private resolveActiveLineup(
    runtimeSnapshot: ReturnType<ProgramRuntime['getSnapshot']>,
    identity: IdentityResolution,
  ): ActiveLineupResolution {
    const runtime = runtimeSnapshot.current;
    const observation = selectProgramSafeRuntimeView(runtime).telemetry;
    this.activeLineup = resolveActiveLineup({
      sourceGeneration: runtime.programSource.generation,
      mapEpoch: runtime.map.epoch,
      ...(observation?.telemetry.allPlayers === undefined
        ? {}
        : { allPlayers: observation.telemetry.allPlayers }),
      ...(observation === null ? {} : { allPlayersCoverage: observation.coverage.allPlayers }),
      ...(this.contextBinding?.context === undefined
        ? {}
        : { context: this.contextBinding.context }),
      identity,
      previous: this.activeLineup,
      ...(this.activeLineupOverride === undefined ? {} : { override: this.activeLineupOverride }),
    });
    return this.activeLineup;
  }

  private publish(
    program: ProgramProjection,
    radar: RadarFrame,
    operator: OperatorProjection,
    assist: ObserverAssistProjection,
  ): void {
    this.publishChannel('program', () =>
      this.publishers.program.publish({
        type: 'snapshot',
        protocolVersion: LOCAL_PROTOCOL_VERSION,
        channel: 'program',
        schemaVersion: PROGRAM_SCHEMA_VERSION,
        cursor: program.cursor,
        payload: mapProgramProjection(program),
      }),
    );
    this.publishChannel('radar', () =>
      this.publishers.radar.publish({
        type: 'snapshot',
        protocolVersion: LOCAL_PROTOCOL_VERSION,
        channel: 'radar',
        schemaVersion: RADAR_SCHEMA_VERSION,
        cursor: radar.cursor,
        payload: mapRadarFrame(radar),
      }),
    );
    this.publishOperator(operator);
    this.publishChannel('assist', () =>
      this.publishers.assist.publish({
        type: 'snapshot',
        protocolVersion: LOCAL_PROTOCOL_VERSION,
        channel: 'assist',
        schemaVersion: ASSIST_SCHEMA_VERSION,
        cursor: assist.cursor,
        payload: mapObserverAssistProjection(assist),
      }),
    );
  }

  private refreshOperator(): ProjectionBundle {
    if (this.closed || this.refreshing) return this.current;
    this.refreshing = true;
    try {
      const runtimeSnapshot = this.programRuntime.getSnapshot();
      const operator = projectOperator({
        runtime: runtimeSnapshot,
        context: this.contextBinding,
        identity: this.current.identity,
        activeLineup: this.activeLineup,
        cstvSources: this.cstvSources,
        nowMonotonicMs: this.nowMonotonicMs(),
      });
      this.current = { ...this.current, operator };
      this.publishOperator(operator);
      return this.current;
    } finally {
      this.refreshing = false;
    }
  }

  private publishOperator(operator: OperatorProjection): void {
    this.publishChannel('operator', () =>
      this.publishers.operator.publish({
        type: 'snapshot',
        protocolVersion: LOCAL_PROTOCOL_VERSION,
        channel: 'operator',
        schemaVersion: OPERATOR_SCHEMA_VERSION,
        cursor: operator.cursor,
        payload: mapOperatorProjection(operator),
      }),
    );
  }

  private publishChannel(channel: string, publish: () => void): void {
    try {
      publish();
    } catch {
      report(this.onDiagnostic, `${channel}-wire-validation-failed`);
    }
  }

  private scheduleStaleDeadline(
    runtimeView: ReturnType<typeof selectProgramSafeRuntimeView>,
    program: ProgramProjection,
    nowMonotonicMs: number,
    policy: ReturnType<ProgramRuntime['getSnapshot']>['continuityPolicy'],
  ): void {
    const lastAccepted = runtimeView.programSourceLastAccepted;
    const receiveSequence = runtimeView.cursor.programReceiveSequence;
    if (runtimeView.telemetry === null || lastAccepted === null || receiveSequence === null) {
      this.cancelStaleTimer();
      this.stalePublishedKey = undefined;
      return;
    }
    if (this.staleSuppressedUntilNewFrame) {
      this.cancelStaleTimer();
      return;
    }

    const key = {
      sourceGeneration: runtimeView.cursor.programSourceGeneration,
      receiveSequence,
    } as const;
    const staleDeadline = lastAccepted.receivedMonotonicMs + policy.staleAfterMs;
    const actionRemainingSeconds = program.bomb?.action?.remainingSeconds ?? null;
    const explosionRemainingSeconds = program.bomb?.explosion?.remainingSeconds ?? null;
    const objectiveClockDeadline =
      actionRemainingSeconds !== null || explosionRemainingSeconds !== null
        ? lastAccepted.receivedMonotonicMs + getObjectiveClockLeaseMs(policy)
        : undefined;
    const staleAlreadyPublished = sameStaleKey(this.stalePublishedKey, key);
    if (staleAlreadyPublished && nowMonotonicMs >= staleDeadline) {
      if (objectiveClockDeadline === undefined || nowMonotonicMs >= objectiveClockDeadline) {
        this.cancelStaleTimer();
        return;
      }
    }
    const deadline =
      staleAlreadyPublished && objectiveClockDeadline !== undefined
        ? objectiveClockDeadline
        : Math.min(staleDeadline, objectiveClockDeadline ?? staleDeadline);
    if (
      sameStaleKey(this.staleTimerKey, key) &&
      this.staleDeadline === deadline &&
      this.staleTimer !== undefined
    ) {
      return;
    }

    this.armStaleTimer(key, deadline, Math.max(0, deadline - nowMonotonicMs));
  }

  private armStaleTimer(
    key: { readonly sourceGeneration: number; readonly receiveSequence: number },
    deadline: number,
    delayMs: number,
  ): void {
    this.cancelStaleTimer();
    this.staleTimerKey = key;
    this.staleDeadline = deadline;
    this.staleTimer = this.scheduler.setTimeout(() => {
      this.handleStaleDeadline(key, deadline);
    }, delayMs);
  }

  private handleStaleDeadline(
    key: { readonly sourceGeneration: number; readonly receiveSequence: number },
    deadline: number,
  ): void {
    this.staleTimer = undefined;
    this.staleTimerKey = undefined;
    this.staleDeadline = undefined;
    if (this.closed) return;

    const runtimeSnapshot = this.programRuntime.getSnapshot();
    const runtimeView = selectProgramSafeRuntimeView(runtimeSnapshot.current);
    const currentReceiveSequence = runtimeView.cursor.programReceiveSequence;
    const currentKey =
      runtimeView.telemetry === null || currentReceiveSequence === null
        ? undefined
        : {
            sourceGeneration: runtimeView.cursor.programSourceGeneration,
            receiveSequence: currentReceiveSequence,
          };
    if (!sameStaleKey(currentKey, key)) {
      this.refresh();
      return;
    }

    const nowMonotonicMs = this.nowMonotonicMs();
    if (nowMonotonicMs <= deadline) {
      this.armStaleTimer(key, deadline, Math.max(1, deadline - nowMonotonicMs + 1));
      return;
    }

    const lastAccepted = runtimeView.programSourceLastAccepted;
    const actionRemainingSeconds = this.current.program.bomb?.action?.remainingSeconds ?? null;
    const explosionRemainingSeconds =
      this.current.program.bomb?.explosion?.remainingSeconds ?? null;
    if (
      lastAccepted !== null &&
      (actionRemainingSeconds !== null || explosionRemainingSeconds !== null) &&
      nowMonotonicMs >
        lastAccepted.receivedMonotonicMs +
          getObjectiveClockLeaseMs(runtimeSnapshot.continuityPolicy)
    ) {
      this.refresh();
      return;
    }

    if (sameStaleKey(this.stalePublishedKey, key)) return;
    this.stalePublishedKey = key;
    this.refresh();
  }

  private cancelStaleTimer(): void {
    if (this.staleTimer !== undefined) this.scheduler.clearTimeout(this.staleTimer);
    this.staleTimer = undefined;
    this.staleTimerKey = undefined;
    this.staleDeadline = undefined;
  }
}

function seriesSideProofFor(
  runtimeSnapshot: ReturnType<ProgramRuntime['getSnapshot']>,
  identity: IdentityResolution,
): SeriesSideProof | null {
  const runtime = runtimeSnapshot.current;
  if (
    !identity.capabilities.identityDependentResult ||
    identity.sourceGeneration !== runtime.programSource.generation ||
    identity.mapEpoch !== runtime.map.epoch ||
    identity.sideMapping.a === 'unknown' ||
    identity.sideMapping.b === 'unknown' ||
    identity.sideMapping.a === identity.sideMapping.b
  ) {
    return null;
  }
  return {
    sourceGeneration: runtime.programSource.generation,
    mapEpoch: runtime.map.epoch,
    a: identity.sideMapping.a,
    b: identity.sideMapping.b,
  };
}

function sameStaleKey(
  left: { readonly sourceGeneration: number; readonly receiveSequence: number } | undefined,
  right: { readonly sourceGeneration: number; readonly receiveSequence: number } | undefined,
): boolean {
  return (
    left !== undefined &&
    right !== undefined &&
    left.sourceGeneration === right.sourceGeneration &&
    left.receiveSequence === right.receiveSequence
  );
}

export function createProjectionCoordinator(
  options: ProjectionCoordinatorOptions,
): ProjectionCoordinator {
  return new ProjectionCoordinator(options);
}
