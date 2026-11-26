import { BombDamageResources } from './bomb-damage-resources.js';
import {
  emptyActiveLineup,
  resolveActiveLineup,
  type ActiveLineupOverride,
  type ActiveLineupResolution,
  type IdentityResolution,
} from '@mizar/core/identity';
import {
  getProjectionIdentityCapabilities,
  getProjectionIdentityState,
  getProgramSafeRuntimeFreshness,
  projectObserverAssist,
  ObserverHintTimeline,
  inspectBp,
  projectProgram,
  selectProgramSafeRuntimeView,
  shouldNeutralizeGameplayProjection,
  type ObserverAssistProjection,
  type ProgramProjection,
} from '@mizar/core/projection';
import { getObjectiveClockLeaseMs } from '@mizar/core/runtime';
import { assistSnapshotSchema, type AssistSnapshot } from '@mizar/protocol/assist';
import { operatorSnapshotSchema, type OperatorSnapshot } from '@mizar/protocol/operator';
import { programSnapshotSchema, type ProgramSnapshot } from '@mizar/protocol/program';
import { radarSnapshotSchema, type RadarSnapshot } from '@mizar/protocol/radar';
import {
  ASSIST_SCHEMA_VERSION,
  LOCAL_PROTOCOL_VERSION,
  OPERATOR_SCHEMA_VERSION,
  PROGRAM_SCHEMA_VERSION,
  RADAR_SCHEMA_VERSION,
} from '@mizar/protocol/version';
import { projectRadarFrame, type RadarFrame } from '@mizar/radar';
import { CS2_ITEM_CATALOG } from '@mizar/cs2-assets';

import type { RuntimeDisposition, RuntimeTransition } from '@mizar/core/runtime';
import type { MatchContextBinding } from '../match-context/index.js';
import type { CstvSourceHealth, CstvSourceManagers } from '../telemetry/cstv-source-manager.js';
import type {
  ProgramRuntime,
  ProgramRuntimeSnapshot,
  ProgramCommitResult,
} from '../runtime/program-runtime.js';
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
  readonly observerSettings?: () => {
    enabled: boolean;
    nicknameSource?: 'game' | 'website';
    leadSeconds: number;
    delaySeconds: number;
  };
  readonly onObserverDiagnostics?: (
    diagnostics: ReturnType<ObserverHintTimeline['getDiagnostics']>,
  ) => void;
  readonly programChat?: (
    cursor: ProgramSnapshot['cursor'],
    fresh: boolean,
  ) => NonNullable<ProgramSnapshot['payload']['allChat']>;
  /** Step replay publishes each cursor immediately, then explicitly drains predictions. */
  readonly predictionPublishCoalescing?: boolean;
  readonly avatars?: { get(id: string): string | null; request(ids: readonly string[]): void };
  readonly programRuntime: ProgramRuntime;
  readonly cstvSources: CstvSourceManagers;
  readonly activeLineupOverride?: ActiveLineupOverride;
  readonly matchContextBinding?: MatchContextBinding;
  readonly nowMonotonicMs?: () => number;
  readonly scheduler?: ProjectionScheduler;
  readonly publishers?: ProjectionPublishers;
  readonly onDiagnostic?: (diagnostic: { readonly code: string }) => void;
  readonly onProjection?: (bundle: ProjectionBundle) => void;
}

export interface ProjectionScheduler {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

const defaultNowMonotonicMs = (): number => globalThis.performance.now();
const equipmentCatalog = Object.fromEntries(
  CS2_ITEM_CATALOG.flatMap(({ canonicalKey, kind, family, gsiWeaponNames, aliases }) =>
    [...gsiWeaponNames, ...aliases].map((name) => [name, { canonicalKey, kind, family }]),
  ),
);
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
  private readonly onObserverDiagnostics: ProjectionCoordinatorOptions['onObserverDiagnostics'];
  private readonly observerTimeline = new ObserverHintTimeline();
  private readonly observerSettings: ProjectionCoordinatorOptions['observerSettings'];
  private readonly assistTimer: ReturnType<typeof setInterval> | undefined;
  private readonly predictionPublishCoalescing: boolean;
  private readonly avatars: ProjectionCoordinatorOptions['avatars'];
  private readonly programChat: ProjectionCoordinatorOptions['programChat'];
  private readonly bombDamageResources = new BombDamageResources(() => this.refreshProgram());
  private readonly presentationListeners = new Set<(bundle: ProjectionBundle) => void>();

  subscribePresentation(listener: (bundle: ProjectionBundle) => void): () => void {
    this.presentationListeners.add(listener);
    listener(this.current);
    return () => {
      this.presentationListeners.delete(listener);
    };
  }

  private readonly programRuntime: ProgramRuntime;
  private readonly cstvSources: CstvSourceManagers;
  private readonly activeLineupOverride: ActiveLineupOverride | undefined;
  private readonly nowMonotonicMs: () => number;
  private readonly scheduler: ProjectionScheduler;
  private readonly publishers: Required<ProjectionPublishers>;
  private readonly onDiagnostic: ((diagnostic: { readonly code: string }) => void) | undefined;
  private readonly onProjection: ((bundle: ProjectionBundle) => void) | undefined;
  private readonly sourceUnsubscribers: readonly (() => void)[];
  private contextBinding: MatchContextBinding | undefined;
  private current: ProjectionBundle;
  private lastPublishedProgram: ProgramProjection | undefined;
  private lastPublishedAssist: ObserverAssistProjection | undefined;
  private lastOperatorPublishMs: number | undefined;
  private lastOperatorState: OperatorStructuralState | undefined;
  private predictionPublishTimer: unknown;
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
    this.observerSettings = options.observerSettings;
    this.programChat = options.programChat;
    this.predictionPublishCoalescing = options.predictionPublishCoalescing ?? true;
    this.avatars = options.avatars;
    this.programRuntime = options.programRuntime;
    this.cstvSources = options.cstvSources;
    this.activeLineupOverride = options.activeLineupOverride;
    this.nowMonotonicMs = options.nowMonotonicMs ?? defaultNowMonotonicMs;
    this.scheduler = options.scheduler ?? defaultScheduler;
    this.onDiagnostic = options.onDiagnostic;
    this.onProjection = options.onProjection;
    this.onObserverDiagnostics = options.onObserverDiagnostics;
    this.publishers = mergePublishers(options.publishers, options.onDiagnostic);
    this.contextBinding = options.matchContextBinding;
    this.activeLineup = emptyActiveLineup();
    this.current = this.refresh();
    this.assistTimer = options.observerSettings
      ? setInterval(() => {
          if (this.observerSettings?.().enabled) this.refreshAssist();
        }, 200)
      : undefined;
    this.assistTimer?.unref();
    this.sourceUnsubscribers = [
      this.cstvSources.program.subscribe(() => this.refreshOperator()),
      this.cstvSources.lookahead.subscribe(() => {
        this.refreshOperator();
        this.refreshAssist();
      }),
      this.cstvSources.lookahead.subscribeLiveGameEvents((event) => {
        if (!this.observerSettings?.().enabled) return;
        this.observerTimeline.consume(event);
        this.refreshAssist();
      }),
      ...(this.cstvSources.lookahead.subscribeTimelineReset
        ? [
            this.cstvSources.lookahead.subscribeTimelineReset(() => {
              if (!this.observerSettings?.().enabled) return;
              this.resetObserverAssist();
            }),
          ]
        : []),
    ];
  }

  setMatchContextBinding(
    binding: MatchContextBinding | undefined,
    committed: ProgramRuntimeSnapshot,
  ): ProjectionBundle {
    if (this.closed) return this.current;
    const previousMatch = this.contextBinding?.context.matchId;
    this.contextBinding = binding;
    if (!binding || (previousMatch !== undefined && previousMatch !== binding.context.matchId)) {
      const runtime = committed.current;
      this.activeLineup = emptyActiveLineup(runtime.programSource.generation, runtime.map.epoch);
    }
    return this.refreshDomains(
      { program: true, radar: true, operator: true, assist: true, forceOperator: true },
      false,
      committed,
    );
  }

  afterRuntimeMutation(result: ProgramCommitResult): ProjectionBundle {
    if (this.closed || result.disposition.kind !== 'accepted') return this.current;
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
    return this.refreshDomains(
      { program: true, radar: true, operator: true, assist: true, forceOperator: false },
      result.disposition.reason === 'program-round-events',
      result.snapshot,
    );
  }

  refresh(publishWaiting = false, committed?: ProgramRuntimeSnapshot): ProjectionBundle {
    return this.refreshDomains(
      { program: true, radar: true, operator: true, assist: true, forceOperator: false },
      publishWaiting,
      committed,
    );
  }

  private refreshProgram(publishWaiting = false): ProjectionBundle {
    return this.refreshDomains(
      { program: true, radar: false, operator: false, assist: false, forceOperator: false },
      publishWaiting,
    );
  }

  private refreshDomains(
    domains: {
      readonly program: boolean;
      readonly radar: boolean;
      readonly operator: boolean;
      readonly assist: boolean;
      readonly forceOperator: boolean;
    },
    publishWaiting = false,
    committed?: ProgramRuntimeSnapshot,
  ): ProjectionBundle {
    if (this.closed || this.refreshing) return this.current;
    this.refreshing = true;
    try {
      const runtimeSnapshot = committed ?? this.programRuntime.getSnapshot();
      const runtimeState = runtimeSnapshot.current;
      const runtimeView = selectProgramSafeRuntimeView(runtimeState);
      const identity = runtimeSnapshot.identity;
      const activeLineup =
        domains.program || domains.operator
          ? this.resolveActiveLineup(runtimeSnapshot, identity)
          : this.activeLineup;
      const context = this.contextBinding?.context;
      const preferCanonicalPlayerNames =
        this.observerSettings?.().nicknameSource === 'website' &&
        this.contextBinding !== undefined &&
        this.contextBinding.localAuthoringMode !== 'standalone' &&
        (this.contextBinding.origin === 'online' ||
          this.contextBinding.cachedFrom === 'online' ||
          this.contextBinding.localAuthoringMode === 'bound-overlay');
      const nowMonotonicMs = this.nowMonotonicMs();
      const telemetryFreshness = getProgramSafeRuntimeFreshness(
        runtimeView,
        nowMonotonicMs,
        runtimeSnapshot.continuityPolicy,
      );

      let program = this.current?.program;
      let gameplay = this.lastPublishedProgram ?? program;
      if (domains.program) {
        const needsNeutralGameplay = shouldNeutralizeGameplayProjection(
          telemetryFreshness,
          runtimeView.telemetry?.telemetry.map?.name,
          identity.state,
        );
        const programInput = {
          preferCanonicalPlayerNames,
          equipmentCatalog,
          runtime: runtimeView,
          bombDamageResource: this.bombDamageResources.get(
            runtimeView.telemetry?.telemetry.map?.name ?? null,
            `${runtimeView.cursor.programSourceGeneration}:${runtimeView.cursor.mapEpoch}`,
          ),
          ...(context === undefined ? {} : { context }),
          ...(this.contextBinding === undefined
            ? {}
            : { contextFreshness: this.contextBinding.freshness }),
          identity,
          activeLineup,
          seriesProgress: runtimeSnapshot.seriesProgress,
          nowMonotonicMs,
          continuityPolicy: runtimeSnapshot.continuityPolicy,
        };
        const withAvatars = (p: ProgramProjection): ProgramProjection => ({
          ...p,
          players: p.players.map((player) => ({
            ...player,
            avatarUrl: player.avatarUrl ?? this.avatars?.get(player.sourcePlayerId) ?? null,
          })),
        });
        const baseProgram = projectProgram(programInput);
        program = withAvatars(baseProgram);
        gameplay = needsNeutralGameplay
          ? withAvatars(projectProgram({ ...programInput, presentationRole: 'gameplay' }))
          : program;
        this.avatars?.request(
          baseProgram.players
            .filter((player) => player.avatarUrl === null)
            .map((player) => player.sourcePlayerId),
        );
        this.scheduleStaleDeadline(
          runtimeView,
          program,
          nowMonotonicMs,
          runtimeSnapshot.continuityPolicy,
        );
        const prior = this.lastPublishedProgram;
        const cursor = gameplay.cursor;
        const coalescePredictionWait =
          this.predictionPublishCoalescing &&
          !publishWaiting &&
          prior !== undefined &&
          prior.status.telemetry === 'fresh' &&
          gameplay.status.telemetry === 'fresh' &&
          gameplay.status.context === prior.status.context &&
          gameplay.status.identity === prior.status.identity &&
          gameplay.match?.matchId === prior.match?.matchId &&
          cursor.producerInstanceId === prior.cursor.producerInstanceId &&
          cursor.liveSessionId === prior.cursor.liveSessionId &&
          cursor.programSourceGeneration === prior.cursor.programSourceGeneration &&
          cursor.mapEpoch === prior.cursor.mapEpoch &&
          gameplay.round?.phase === 'live' &&
          gameplay.map?.roundNumber === prior.map?.roundNumber &&
          gameplay.map?.score.ct === prior.map?.score.ct &&
          gameplay.map?.score.t === prior.map?.score.t &&
          gameplay.clock?.phase === prior.clock?.phase &&
          gameplay.bomb?.state === prior.bomb?.state &&
          gameplay.bombDamage.players.some(
            (player) => player.status === 'unavailable' && player.reason === 'prediction-loading',
          ) &&
          gameplay.bombDamage.players.every(
            (player) =>
              player.status === 'predicted' ||
              player.reason === 'prediction-loading' ||
              prior.bombDamage.players.some(
                (previous) =>
                  previous.sourcePlayerId === player.sourcePlayerId &&
                  previous.status === 'unavailable' &&
                  previous.reason === player.reason,
              ),
          );
        if (coalescePredictionWait) {
          // Keep the existing WHOLE published snapshot and its original cursor.
          // A completion reprojects latest state; never attach old estimates to a
          // new input. A slow worker still exposes waiting after one display frame.
          this.predictionPublishTimer ??= this.scheduler.setTimeout(() => {
            this.predictionPublishTimer = undefined;
            this.refresh(true);
          }, 16);
          return this.current;
        }
        if (this.predictionPublishTimer !== undefined) {
          this.scheduler.clearTimeout(this.predictionPublishTimer);
          this.predictionPublishTimer = undefined;
        }
      }

      const radar = domains.radar
        ? projectRadarFrame({
            preferCanonicalPlayerNames,
            ...(context === undefined ? {} : { context }),
            runtime: runtimeView,
            identity,
            nowMonotonicMs,
            continuityPolicy: runtimeSnapshot.continuityPolicy,
          })
        : this.current.radar;

      let operator = this.current?.operator;
      let operatorStructuralState: OperatorStructuralState | undefined;
      let operatorRefreshed = false;
      if (domains.operator) {
        operatorStructuralState = buildOperatorStructuralState({
          runtimeSnapshot,
          runtimeView,
          telemetryFreshness,
          contextBinding: this.contextBinding,
          identity,
          activeLineup,
          cstvSources: this.cstvSources,
        });
        if (
          domains.forceOperator ||
          this.lastOperatorState === undefined ||
          this.lastOperatorPublishMs === undefined ||
          !sameOperatorStructuralState(this.lastOperatorState, operatorStructuralState) ||
          nowMonotonicMs < this.lastOperatorPublishMs ||
          nowMonotonicMs - this.lastOperatorPublishMs >= OPERATOR_HEARTBEAT_THROTTLE_MS
        ) {
          operator = projectOperator({
            runtime: runtimeSnapshot,
            context: this.contextBinding,
            identity,
            activeLineup,
            cstvSources: this.cstvSources,
            nowMonotonicMs,
          });
          operatorRefreshed = true;
        }
      }

      const assist = domains.assist
        ? this.assistance(program, nowMonotonicMs, runtimeSnapshot)
        : this.current.assist;

      this.current = { program, radar, operator, assist, identity };

      for (const listener of this.presentationListeners) {
        try {
          listener(this.current);
        } catch {
          report(this.onDiagnostic, 'presentation-projection-failed');
        }
      }

      if (domains.program && gameplay !== undefined) {
        this.publishProgram(gameplay);
        this.lastPublishedProgram = gameplay;
      }
      if (domains.radar) this.publishRadar(radar);
      if (operatorRefreshed && operatorStructuralState !== undefined) {
        this.publishOperator(operator);
        this.lastOperatorState = operatorStructuralState;
        this.lastOperatorPublishMs = nowMonotonicMs;
      }
      if (domains.assist) this.publishAssist(assist);

      try {
        this.onProjection?.(this.current);
      } catch {
        report(this.onDiagnostic, 'output-projection-failed');
      }
      return this.current;
    } finally {
      this.refreshing = false;
    }
  }

  async prepareBombDamageMap(mapName: string | null): Promise<void> {
    await this.bombDamageResources.prepare(mapName);
  }

  async settleBombDamage(): Promise<ProjectionBundle> {
    // A full queue may initially contain the previous frame. Re-project and
    // drain the current inputs as well; production reception never awaits this.
    while (await this.bombDamageResources.settlePredictions()) this.refreshProgram();
    return this.current;
  }

  getBpProjection() {
    return this.getBpAssessment().projection;
  }

  getBpAssessment() {
    if (this.getCurrent().identity.state === 'mismatch')
      return { readiness: 'conflict' as const, projection: null };
    return inspectBp(this.contextBinding?.context);
  }

  getRosterEvidence() {
    const { current: runtime } = this.programRuntime.getSnapshot();
    const lineup = this.activeLineup;
    const observation = selectProgramSafeRuntimeView(runtime).telemetry;
    if (
      this.current.operator.runtime.telemetryFreshness !== 'fresh' ||
      observation?.coverage.allPlayers !== 'present' ||
      lineup.state !== 'complete' ||
      lineup.sourceGeneration !== runtime.programSource.generation ||
      lineup.mapEpoch !== runtime.map.epoch ||
      [...lineup.ct, ...lineup.t].some(
        (player) => player.lineupEvidence !== 'current' || !player.observed,
      )
    )
      return null;
    return {
      sourceGeneration: lineup.sourceGeneration,
      mapEpoch: lineup.mapEpoch,
      ctName:
        observation.coverage.map === 'present'
          ? observation.telemetry.map?.sides?.ct?.name?.trim() || null
          : null,
      tName:
        observation.coverage.map === 'present'
          ? observation.telemetry.map?.sides?.t?.name?.trim() || null
          : null,
      ct: lineup.ct.map((player) => ({
        steam64: player.sourcePlayerId,
        displayName: player.observed?.displayName ?? null,
      })),
      t: lineup.t.map((player) => ({
        steam64: player.sourcePlayerId,
        displayName: player.observed?.displayName ?? null,
      })),
    };
  }

  getCurrent(): ProjectionBundle {
    return this.current;
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
    if (this.assistTimer) clearInterval(this.assistTimer);
    if (this.predictionPublishTimer !== undefined)
      this.scheduler.clearTimeout(this.predictionPublishTimer);
    this.bombDamageResources.close();
    this.cancelStaleTimer();
    for (const unsubscribe of this.sourceUnsubscribers) unsubscribe();
    await Promise.all([
      this.publishers.program.close(),
      this.publishers.radar.close(),
      this.publishers.operator.close(),
      this.publishers.assist.close(),
    ]);
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

  private publishProgram(program: ProgramProjection): void {
    this.publishChannel('program', () =>
      this.publishers.program.publish({
        type: 'snapshot',
        protocolVersion: LOCAL_PROTOCOL_VERSION,
        channel: 'program',
        schemaVersion: PROGRAM_SCHEMA_VERSION,
        cursor: program.cursor,
        payload: {
          ...mapProgramProjection(program),
          ...(this.programChat
            ? { allChat: this.programChat(program.cursor, program.status.telemetry === 'fresh') }
            : {}),
        },
      }),
    );
  }

  private publishRadar(radar: RadarFrame): void {
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
  }

  private assistance(
    program: ProgramProjection,
    now: number,
    runtimeSnapshot?: ProgramRuntimeSnapshot,
  ): ObserverAssistProjection {
    const snapshot = runtimeSnapshot ?? this.programRuntime.getSnapshot();
    const settings = this.observerSettings?.();
    if (!settings) return projectObserverAssist(selectProgramSafeRuntimeView(snapshot.current));
    const health = this.cstvSources.lookahead.getHealth();
    const received = health.lastReceiveMonotonicMs;
    const sourceMapName = health.mapName;
    const receiveAgeMs = received === undefined || received > now ? null : now - received;
    const freshness =
      receiveAgeMs === null
        ? 'unknown'
        : receiveAgeMs <= snapshot.continuityPolicy.staleAfterMs
          ? 'fresh'
          : 'stale';
    return this.observerTimeline.project(program, settings, now, {
      connected: health.state === 'live',
      state: health.state,
      ...(health.lastErrorCode ? { lastErrorCode: health.lastErrorCode } : {}),
      generation: health.generation,
      sameMap: sourceMapName !== undefined && sourceMapName === program.map.name,
      ...(sourceMapName === undefined ? {} : { mapName: sourceMapName }),
      fresh: freshness === 'fresh',
      freshness,
      lastReceiveMonotonicMs: received ?? null,
      receiveAgeMs,
    });
  }
  refreshAssist(): void {
    if (this.closed || !this.current) return;
    const assist = this.assistance(this.current.program, this.nowMonotonicMs());
    this.current = { ...this.current, assist };
    this.publishAssist(assist);
  }

  private publishAssist(assist: ObserverAssistProjection): void {
    if (shouldPublishAssist(this.lastPublishedAssist, assist)) {
      const previous = this.publishers.assist.getCurrent()?.channelSeq;
      this.publishChannel('assist', () => {
        this.publishers.assist.publish({
          type: 'snapshot',
          protocolVersion: LOCAL_PROTOCOL_VERSION,
          channel: 'assist',
          schemaVersion: ASSIST_SCHEMA_VERSION,
          cursor: assist.cursor,
          payload: mapObserverAssistProjection(assist),
        });
        const current = this.publishers.assist.getCurrent();
        if (current && current.channelSeq !== previous && assist.observer?.hints.length)
          this.observerTimeline.recordPublished(assist.observer.hints);
        this.lastPublishedAssist = assist;
      });
    }
    if (!this.observerSettings) return;
    try {
      this.onObserverDiagnostics?.(this.observerTimeline.getDiagnostics());
    } catch {
      report(this.onDiagnostic, 'observer-assist-diagnostic-sink-failed');
    }
  }
  resetObserverAssist(): void {
    this.observerTimeline.resetForMap(this.nowMonotonicMs());
    this.refreshAssist();
  }
  private refreshOperator(): ProjectionBundle {
    if (this.closed || this.refreshing) return this.current;
    this.refreshing = true;
    try {
      const runtimeSnapshot = this.programRuntime.getSnapshot();
      const runtimeView = selectProgramSafeRuntimeView(runtimeSnapshot.current);
      const nowMonotonicMs = this.nowMonotonicMs();
      const telemetryFreshness = getProgramSafeRuntimeFreshness(
        runtimeView,
        nowMonotonicMs,
        runtimeSnapshot.continuityPolicy,
      );
      const structuralState = buildOperatorStructuralState({
        runtimeSnapshot,
        runtimeView,
        telemetryFreshness,
        contextBinding: this.contextBinding,
        identity: this.current.identity,
        activeLineup: this.activeLineup,
        cstvSources: this.cstvSources,
      });
      const operator = projectOperator({
        runtime: runtimeSnapshot,
        context: this.contextBinding,
        identity: this.current.identity,
        activeLineup: this.activeLineup,
        cstvSources: this.cstvSources,
        nowMonotonicMs,
      });
      this.current = { ...this.current, operator };
      this.publishOperator(operator);
      this.lastOperatorState = structuralState;
      this.lastOperatorPublishMs = nowMonotonicMs;
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
      if (
        nowMonotonicMs >=
        lastAccepted.receivedMonotonicMs + runtimeSnapshot.continuityPolicy.staleAfterMs
      ) {
        this.stalePublishedKey = key;
        this.refresh();
      } else {
        this.refreshProgram();
      }
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

const OPERATOR_HEARTBEAT_THROTTLE_MS = 1_000;

interface OperatorStructuralState {
  readonly producerInstanceId: string;
  readonly liveSessionId: string | null;
  readonly programSourceGeneration: number;
  readonly mapEpoch: number;
  readonly telemetryFreshness: 'awaiting' | 'fresh' | 'stale';
  readonly mapName: string | null;
  readonly lastDisposition: RuntimeDisposition | null;
  readonly recentTransitionsLength: number;
  readonly latestTransition: RuntimeTransition | undefined;
  readonly matchContext: MatchContextBinding | undefined;
  readonly seriesProgress: ProgramRuntimeSnapshot['seriesProgress'];
  readonly identityState: IdentityResolution['state'];
  readonly identityCapabilities: IdentityResolution['capabilities'];
  readonly identitySideMapping: IdentityResolution['sideMapping'];
  readonly identityIssues: IdentityResolution['issues'];
  readonly identityResolvedCount: number;
  readonly identityUnresolved: IdentityResolution['unresolved'];
  readonly activeLineup: ActiveLineupResolution;
  readonly cstvProgram: CstvSourceHealth<'program'>;
  readonly cstvLookahead: CstvSourceHealth<'lookahead'>;
}

function buildOperatorStructuralState(input: {
  readonly runtimeSnapshot: ProgramRuntimeSnapshot;
  readonly runtimeView: ReturnType<typeof selectProgramSafeRuntimeView>;
  readonly telemetryFreshness: 'awaiting' | 'fresh' | 'stale';
  readonly contextBinding: MatchContextBinding | undefined;
  readonly identity: IdentityResolution;
  readonly activeLineup: ActiveLineupResolution;
  readonly cstvSources: CstvSourceManagers;
}): OperatorStructuralState {
  const transitions = input.runtimeSnapshot.recentTransitions;
  return {
    producerInstanceId: input.runtimeView.cursor.producerInstanceId,
    liveSessionId: input.runtimeView.cursor.liveSessionId,
    programSourceGeneration: input.runtimeView.cursor.programSourceGeneration,
    mapEpoch: input.runtimeView.cursor.mapEpoch,
    telemetryFreshness: input.telemetryFreshness,
    mapName: input.runtimeView.telemetry?.telemetry.map?.name ?? null,
    lastDisposition: input.runtimeSnapshot.lastDisposition ?? null,
    recentTransitionsLength: transitions.length,
    latestTransition: transitions[transitions.length - 1],
    matchContext: input.contextBinding,
    seriesProgress: input.runtimeSnapshot.seriesProgress,
    identityState: getProjectionIdentityState(input.runtimeView, input.identity),
    identityCapabilities: getProjectionIdentityCapabilities(input.runtimeView, input.identity),
    identitySideMapping: input.identity.sideMapping,
    identityIssues: input.identity.issues,
    identityResolvedCount: input.identity.players.length,
    identityUnresolved: input.identity.unresolved,
    activeLineup: input.activeLineup,
    cstvProgram: input.cstvSources.program.getHealth(),
    cstvLookahead: input.cstvSources.lookahead.getHealth(),
  };
}

function sameDisposition(a: RuntimeDisposition | null, b: RuntimeDisposition | null): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (a.kind !== b.kind || a.reason !== b.reason) return false;
  if (a.kind === 'accepted' && b.kind === 'accepted') {
    const am = 'missingSequenceRange' in a ? a.missingSequenceRange : undefined;
    const bm = 'missingSequenceRange' in b ? b.missingSequenceRange : undefined;
    return am?.from === bm?.from && am?.to === bm?.to;
  }
  return true;
}

function sameTransition(
  a: RuntimeTransition | undefined,
  b: RuntimeTransition | undefined,
): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  return (
    a.kind === b.kind && a.runtimeSeq === b.runtimeSeq && a.at.monotonicMs === b.at.monotonicMs
  );
}

function sameSeriesProgress(
  a: ProgramRuntimeSnapshot['seriesProgress'],
  b: ProgramRuntimeSnapshot['seriesProgress'],
): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  return (
    a.bindingState === b.bindingState &&
    a.requiredWins === b.requiredWins &&
    a.score.a === b.score.a &&
    a.score.b === b.score.b &&
    a.currentMapOrder === b.currentMapOrder &&
    a.maps.length === b.maps.length &&
    a.issues.length === b.issues.length &&
    a.maps.every((map, index) => {
      const other = b.maps[index]!;
      return (
        map.mapOrder === other.mapOrder &&
        map.mapName === other.mapName &&
        map.status === other.status &&
        map.executionMapEpoch === other.executionMapEpoch &&
        map.finalScore?.a === other.finalScore?.a &&
        map.finalScore?.b === other.finalScore?.b &&
        map.roundHistory.completeness === other.roundHistory.completeness
      );
    }) &&
    a.issues.every((issue, index) => issue.code === b.issues[index]!.code)
  );
}

function sameActiveLineup(a: ActiveLineupResolution, b: ActiveLineupResolution): boolean {
  if (a === b) return true;
  if (
    a.state !== b.state ||
    a.sourceGeneration !== b.sourceGeneration ||
    a.mapEpoch !== b.mapEpoch ||
    a.ct.length !== b.ct.length ||
    a.t.length !== b.t.length ||
    a.extras.length !== b.extras.length ||
    a.issues.length !== b.issues.length
  ) {
    return false;
  }
  const aRetained = [...a.ct, ...a.t].filter((p) => p.lineupEvidence === 'retained').length;
  const bRetained = [...b.ct, ...b.t].filter((p) => p.lineupEvidence === 'retained').length;
  if (aRetained !== bRetained) return false;
  return (
    a.extras.every((extra, index) => {
      const other = b.extras[index]!;
      return (
        extra.sourcePlayerId === other.sourcePlayerId &&
        extra.displayName === other.displayName &&
        extra.side === other.side &&
        extra.activity === other.activity
      );
    }) && a.issues.every((issue, index) => issue.code === b.issues[index]!.code)
  );
}

function sameCstvHealth(a: CstvSourceHealth, b: CstvSourceHealth): boolean {
  if (a === b) return true;
  return (
    a.state === b.state &&
    a.generation === b.generation &&
    a.mapName === b.mapName &&
    a.lastErrorCode === b.lastErrorCode &&
    a.lastEventSequence === b.lastEventSequence
  );
}

function sameOperatorStructuralState(
  a: OperatorStructuralState,
  b: OperatorStructuralState,
): boolean {
  return (
    a.producerInstanceId === b.producerInstanceId &&
    a.liveSessionId === b.liveSessionId &&
    a.programSourceGeneration === b.programSourceGeneration &&
    a.mapEpoch === b.mapEpoch &&
    a.telemetryFreshness === b.telemetryFreshness &&
    a.mapName === b.mapName &&
    sameDisposition(a.lastDisposition, b.lastDisposition) &&
    a.recentTransitionsLength === b.recentTransitionsLength &&
    sameTransition(a.latestTransition, b.latestTransition) &&
    a.matchContext === b.matchContext &&
    sameSeriesProgress(a.seriesProgress, b.seriesProgress) &&
    a.identityState === b.identityState &&
    a.identityCapabilities.canonicalPlayerMapping ===
      b.identityCapabilities.canonicalPlayerMapping &&
    a.identityCapabilities.canonicalTeamBranding === b.identityCapabilities.canonicalTeamBranding &&
    a.identityCapabilities.identityDependentResult ===
      b.identityCapabilities.identityDependentResult &&
    a.identityCapabilities.neutralTelemetry === b.identityCapabilities.neutralTelemetry &&
    a.identitySideMapping.a === b.identitySideMapping.a &&
    a.identitySideMapping.b === b.identitySideMapping.b &&
    a.identityResolvedCount === b.identityResolvedCount &&
    a.identityIssues.length === b.identityIssues.length &&
    a.identityIssues.every((issue, i) => issue.code === b.identityIssues[i]!.code) &&
    a.identityUnresolved.length === b.identityUnresolved.length &&
    a.identityUnresolved.every(
      (player, i) =>
        player.sourcePlayerId === b.identityUnresolved[i]!.sourcePlayerId &&
        player.side === b.identityUnresolved[i]!.side,
    ) &&
    sameActiveLineup(a.activeLineup, b.activeLineup) &&
    sameCstvHealth(a.cstvProgram, b.cstvProgram) &&
    sameCstvHealth(a.cstvLookahead, b.cstvLookahead)
  );
}

function shouldPublishAssist(
  previous: ObserverAssistProjection | undefined,
  next: ObserverAssistProjection,
): boolean {
  if (previous === undefined) return true;
  if (
    previous.cursor.producerInstanceId !== next.cursor.producerInstanceId ||
    previous.cursor.liveSessionId !== next.cursor.liveSessionId ||
    previous.cursor.programSourceGeneration !== next.cursor.programSourceGeneration ||
    previous.cursor.mapEpoch !== next.cursor.mapEpoch
  ) {
    return true;
  }
  if (previous.availability !== next.availability) return true;
  const prevObs = previous.observer;
  const nextObs = next.observer;
  if (prevObs === undefined || nextObs === undefined) return prevObs !== nextObs;
  if (
    prevObs.enabled !== nextObs.enabled ||
    prevObs.leadSeconds !== nextObs.leadSeconds ||
    prevObs.delaySeconds !== nextObs.delaySeconds ||
    prevObs.state !== nextObs.state ||
    prevObs.waitingReason !== nextObs.waitingReason ||
    prevObs.nextWindowSeconds !== nextObs.nextWindowSeconds ||
    prevObs.hints.length !== nextObs.hints.length
  ) {
    return true;
  }
  return prevObs.hints.some((hint, index) => {
    const other = nextObs.hints[index]!;
    return (
      hint.id !== other.id ||
      hint.remainingSeconds !== other.remainingSeconds ||
      hint.attacker.name !== other.attacker.name ||
      hint.attacker.observerSlot !== other.attacker.observerSlot ||
      hint.victim.name !== other.victim.name ||
      hint.victim.observerSlot !== other.victim.observerSlot
    );
  });
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
