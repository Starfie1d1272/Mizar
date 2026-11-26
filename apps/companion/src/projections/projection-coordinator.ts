import { BombDamageResources } from './bomb-damage-resources.js';
import {
  emptyActiveLineup,
  resolveActiveLineup,
  type ActiveLineupOverride,
  type ActiveLineupResolution,
  type IdentityResolution,
} from '@mizar/core/identity';
import {
  getProgramSafeRuntimeFreshness,
  projectObserverAssist,
  ObserverHintTimeline,
  inspectBp,
  projectProgram,
  selectProgramSafeRuntimeView,
  shouldNeutralizeGameplayProjection,
  type ObserverAssistProjection,
  type ProgramProjection,
  type ProgramSafeRuntimeFreshness,
  type ProgramSafeRuntimeView,
} from '@mizar/core/projection';
import { getObjectiveClockLeaseMs } from '@mizar/core/runtime';
import {
  assistSnapshotSchema,
  type AssistPayload,
  type AssistSnapshot,
} from '@mizar/protocol/assist';
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

import type { MatchContextBinding } from '../match-context/index.js';
import type { CstvSourceManagers } from '../telemetry/cstv-source-manager.js';
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
  private readonly bombDamageResources = new BombDamageResources(() => this.refresh());
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
  private lastProgramSemantic: ProgramSemanticSnapshot | undefined;
  private lastOperatorSemantic: OperatorSemanticSnapshot | undefined;
  private lastAssistSemantic: AssistSemanticSnapshot | undefined;
  private lastPublishedAssistPayload: AssistPayload | undefined;
  private initialized = false;
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
    return this.refresh(false, committed);
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
    return this.refresh(result.disposition.reason === 'program-round-events', result.snapshot);
  }

  refresh(publishWaiting = false, committed?: ProgramRuntimeSnapshot): ProjectionBundle {
    if (this.closed || this.refreshing) return this.current;
    this.refreshing = true;
    try {
      const runtimeSnapshot = committed ?? this.programRuntime.getSnapshot();
      const runtimeState = runtimeSnapshot.current;
      const runtimeView = selectProgramSafeRuntimeView(runtimeState);
      const identity = runtimeSnapshot.identity;
      const activeLineup = this.resolveActiveLineup(runtimeSnapshot, identity);
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
      const bombDamageResource = this.bombDamageResources.get(
        runtimeView.telemetry?.telemetry.map?.name ?? null,
        `${runtimeView.cursor.programSourceGeneration}:${runtimeView.cursor.mapEpoch}`,
      );
      const needsNeutralGameplay = shouldNeutralizeGameplayProjection(
        telemetryFreshness,
        runtimeView.telemetry?.telemetry.map?.name,
        identity.state,
      );
      const chatSnapshot = this.programChat
        ? this.programChat(runtimeView.cursor, telemetryFreshness === 'fresh')
        : undefined;
      const nextProgramSemantic = buildProgramSemanticSnapshot({
        telemetryFreshness,
        needsNeutralGameplay,
        preferCanonicalPlayerNames,
        context,
        contextFreshness: this.contextBinding?.freshness,
        identity,
        activeLineup,
        seriesProgress: runtimeSnapshot.seriesProgress,
        bombDamageResource,
        runtimeView,
        chatSnapshot,
      });
      const avatarsUpdated =
        this.initialized &&
        this.avatars !== undefined &&
        this.current.program.players.some(
          (player) =>
            player.avatarUrl === null && this.avatars?.get(player.sourcePlayerId) !== null,
        );
      const programChanged =
        !this.initialized ||
        publishWaiting ||
        this.predictionPublishTimer !== undefined ||
        avatarsUpdated ||
        !sameProgramSemantic(this.lastProgramSemantic, nextProgramSemantic);

      let program: ProgramProjection;
      let gameplay: ProgramProjection;
      if (programChanged) {
        const programInput = {
          preferCanonicalPlayerNames,
          equipmentCatalog,
          runtime: runtimeView,
          bombDamageResource,
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
      } else {
        program = this.current.program;
        gameplay = this.lastPublishedProgram ?? program;
      }

      const radar = projectRadarFrame({
        preferCanonicalPlayerNames,
        ...(context === undefined ? {} : { context }),
        runtime: runtimeView,
        identity,
        nowMonotonicMs,
        continuityPolicy: runtimeSnapshot.continuityPolicy,
      });

      const programSourceHealth = this.cstvSources.program.getHealth();
      const lookaheadSourceHealth = this.cstvSources.lookahead.getHealth();
      const nextOperatorSemantic = buildOperatorSemanticSnapshot({
        telemetryFreshness,
        runtimeSnapshot,
        runtimeView,
        contextBinding: this.contextBinding,
        identity,
        activeLineup,
        programSourceHealth,
        lookaheadSourceHealth,
      });
      const operatorChanged =
        !this.initialized || !sameOperatorSemantic(this.lastOperatorSemantic, nextOperatorSemantic);
      const operator = operatorChanged
        ? projectOperator({
            runtime: runtimeSnapshot,
            context: this.contextBinding,
            identity,
            activeLineup,
            cstvSources: this.cstvSources,
            nowMonotonicMs,
          })
        : this.current.operator;

      const nextAssistSemantic = buildAssistSemanticSnapshot({
        program,
        observerSettings: this.observerSettings?.(),
        lookaheadHealth: lookaheadSourceHealth,
      });
      const assistChanged =
        !this.initialized ||
        programChanged ||
        !sameAssistSemantic(this.lastAssistSemantic, nextAssistSemantic);
      const assist = assistChanged ? this.assistance(program, nowMonotonicMs) : this.current.assist;

      this.current = { program, radar, operator, assist, identity };
      this.scheduleStaleDeadline(
        runtimeView,
        program,
        nowMonotonicMs,
        runtimeSnapshot.continuityPolicy,
      );

      if (programChanged) {
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
        for (const listener of this.presentationListeners) {
          try {
            listener(this.current);
          } catch {
            report(this.onDiagnostic, 'presentation-projection-failed');
          }
        }
      }

      this.publish(gameplay, radar, operator, assist, {
        program: programChanged,
        radar: true,
        operator: operatorChanged,
        assist: assistChanged,
        chatSnapshot,
      });

      if (programChanged) {
        this.lastPublishedProgram = gameplay;
        this.lastProgramSemantic = nextProgramSemantic;
        try {
          this.onProjection?.(this.current);
        } catch {
          report(this.onDiagnostic, 'output-projection-failed');
        }
      }
      if (operatorChanged) this.lastOperatorSemantic = nextOperatorSemantic;
      if (assistChanged) this.lastAssistSemantic = nextAssistSemantic;
      this.initialized = true;
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
    while (await this.bombDamageResources.settlePredictions()) this.refresh();
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

  private publish(
    program: ProgramProjection,
    radar: RadarFrame,
    operator: OperatorProjection,
    assist: ObserverAssistProjection,
    channels: {
      readonly program: boolean;
      readonly radar: boolean;
      readonly operator: boolean;
      readonly assist: boolean;
      readonly chatSnapshot?: NonNullable<ProgramSnapshot['payload']['allChat']> | undefined;
    },
  ): void {
    if (channels.program) {
      this.publishChannel('program', () =>
        this.publishers.program.publish({
          type: 'snapshot',
          protocolVersion: LOCAL_PROTOCOL_VERSION,
          channel: 'program',
          schemaVersion: PROGRAM_SCHEMA_VERSION,
          cursor: program.cursor,
          payload: {
            ...mapProgramProjection(program),
            ...(channels.chatSnapshot !== undefined
              ? { allChat: channels.chatSnapshot }
              : this.programChat
                ? {
                    allChat: this.programChat(program.cursor, program.status.telemetry === 'fresh'),
                  }
                : {}),
          },
        }),
      );
    }
    if (channels.radar) {
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
    if (channels.operator) this.publishOperator(operator);
    if (channels.assist) this.publishAssist(assist);
  }

  private assistance(program: ProgramProjection, now: number): ObserverAssistProjection {
    const snapshot = this.programRuntime.getSnapshot();
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
    const payload = mapObserverAssistProjection(assist);
    if (!sameAssistPayload(this.lastPublishedAssistPayload, payload)) {
      const previous = this.publishers.assist.getCurrent()?.channelSeq;
      this.publishChannel('assist', () => {
        this.publishers.assist.publish({
          type: 'snapshot',
          protocolVersion: LOCAL_PROTOCOL_VERSION,
          channel: 'assist',
          schemaVersion: ASSIST_SCHEMA_VERSION,
          cursor: assist.cursor,
          payload,
        });
        this.lastPublishedAssistPayload = payload;
        const current = this.publishers.assist.getCurrent();
        if (current && current.channelSeq !== previous && assist.observer?.hints.length)
          this.observerTimeline.recordPublished(assist.observer.hints);
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

function shallowEqualRecord(a: object, b: object): boolean {
  const ar = a as Record<string, unknown>;
  const br = b as Record<string, unknown>;
  for (const key in ar) {
    if (!Object.is(ar[key], br[key])) return false;
  }
  return true;
}

function deepEqualArrayOrObj(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) if (!deepEqualArrayOrObj(a[i], b[i])) return false;
    return true;
  }
  const ar = a as Record<string, unknown>;
  const br = b as Record<string, unknown>;
  const keys = Object.keys(ar);
  if (keys.length !== Object.keys(br).length) return false;
  for (const k of keys) if (!deepEqualArrayOrObj(ar[k], br[k])) return false;
  return true;
}

type ProgramSemanticSnapshot = ReturnType<typeof buildProgramSemanticSnapshot>;
type OperatorSemanticSnapshot = ReturnType<typeof buildOperatorSemanticSnapshot>;
type AssistSemanticSnapshot = ReturnType<typeof buildAssistSemanticSnapshot>;

function buildProgramSemanticSnapshot(args: {
  readonly telemetryFreshness: ProgramSafeRuntimeFreshness;
  readonly needsNeutralGameplay: boolean;
  readonly preferCanonicalPlayerNames: boolean;
  readonly context: unknown;
  readonly contextFreshness: 'fresh' | 'stale' | undefined;
  readonly identity: IdentityResolution;
  readonly activeLineup: ActiveLineupResolution;
  readonly seriesProgress: ProgramRuntimeSnapshot['seriesProgress'];
  readonly bombDamageResource: unknown;
  readonly runtimeView: ProgramSafeRuntimeView;
  readonly chatSnapshot: NonNullable<ProgramSnapshot['payload']['allChat']> | undefined;
}) {
  const { runtimeView, chatSnapshot } = args;
  const bombState = runtimeView.telemetry?.telemetry.bomb?.state;
  const lastChat = chatSnapshot?.[chatSnapshot.length - 1];
  return {
    telemetryFreshness: args.telemetryFreshness,
    needsNeutralGameplay: args.needsNeutralGameplay,
    preferCanonicalPlayerNames: args.preferCanonicalPlayerNames,
    context: args.context,
    contextFreshness: args.contextFreshness,
    identityState: args.identity.state,
    sideA: args.identity.sideMapping.a,
    sideB: args.identity.sideMapping.b,
    canonicalBranding: args.identity.capabilities.canonicalTeamBranding,
    lineupGen: args.activeLineup.sourceGeneration,
    lineupEpoch: args.activeLineup.mapEpoch,
    lineupState: args.activeLineup.state,
    lineupCtLen: args.activeLineup.ct.length,
    lineupTLen: args.activeLineup.t.length,
    seriesProgress: args.seriesProgress,
    bombDamageResource: args.bombDamageResource,
    producerInstanceId: runtimeView.cursor.producerInstanceId,
    liveSessionId: runtimeView.cursor.liveSessionId,
    programSourceGeneration: runtimeView.cursor.programSourceGeneration,
    mapEpoch: runtimeView.cursor.mapEpoch,
    objectiveTimingActive:
      bombState === 'planting' || bombState === 'defusing' || bombState === 'planted',
    plantDuration: runtimeView.objectiveTiming.plantActionDurationSeconds,
    defuseDuration: runtimeView.objectiveTiming.defuseActionDurationSeconds,
    playerStats: runtimeView.playerStats,
    telemetry: runtimeView.telemetry,
    chatLength: chatSnapshot?.length ?? 0,
    lastChatId: lastChat?.id ?? null,
  };
}

function sameProgramSemantic(
  prev: ProgramSemanticSnapshot | undefined,
  next: ProgramSemanticSnapshot,
): boolean {
  if (!prev || prev.objectiveTimingActive || next.objectiveTimingActive) return false;
  const { telemetry: prevObs, ...prevRest } = prev;
  const { telemetry: nextObs, ...nextRest } = next;
  if (!shallowEqualRecord(prevRest, nextRest)) return false;
  if (prevObs === nextObs) return true;
  if (!prevObs || !nextObs || !shallowEqualRecord(prevObs.coverage, nextObs.coverage)) return false;

  const pt = prevObs.telemetry;
  const nt = nextObs.telemetry;
  if (
    !deepEqualArrayOrObj(pt.map, nt.map) ||
    !deepEqualArrayOrObj(pt.round, nt.round) ||
    !deepEqualArrayOrObj(pt.phaseCountdowns, nt.phaseCountdowns) ||
    pt.player?.sourcePlayerId !== nt.player?.sourcePlayerId ||
    pt.bomb?.state !== nt.bomb?.state ||
    pt.bomb?.sourcePlayerId !== nt.bomb?.sourcePlayerId ||
    pt.bomb?.countdownSeconds !== nt.bomb?.countdownSeconds
  ) {
    return false;
  }
  const bombDamageSensitive =
    nt.round?.phase === 'live' && (nt.bomb?.state === 'planted' || nt.bomb?.state === 'defusing');
  if (bombDamageSensitive && !deepEqualArrayOrObj(pt.bomb?.position, nt.bomb?.position))
    return false;
  const pPlayers = pt.allPlayers;
  const nPlayers = nt.allPlayers;
  if (pPlayers === nPlayers) return true;
  if (!pPlayers || !nPlayers || pPlayers.length !== nPlayers.length) return false;
  for (let i = 0; i < nPlayers.length; i += 1) {
    const pp = pPlayers[i]!;
    const np = nPlayers[i]!;
    if (
      pp.sourcePlayerId !== np.sourcePlayerId ||
      pp.side !== np.side ||
      pp.displayName !== np.displayName ||
      pp.observerSlot !== np.observerSlot ||
      pp.activity !== np.activity ||
      (bombDamageSensitive &&
        (!deepEqualArrayOrObj(pp.position, np.position) ||
          !deepEqualArrayOrObj(pp.forward, np.forward))) ||
      !deepEqualArrayOrObj(pp.state, np.state) ||
      !deepEqualArrayOrObj(pp.matchStats, np.matchStats) ||
      !deepEqualArrayOrObj(pp.weapons, np.weapons)
    ) {
      return false;
    }
  }
  return true;
}

function buildOperatorSemanticSnapshot(args: {
  readonly telemetryFreshness: ProgramSafeRuntimeFreshness;
  readonly runtimeSnapshot: ProgramRuntimeSnapshot;
  readonly runtimeView: ProgramSafeRuntimeView;
  readonly contextBinding: MatchContextBinding | undefined;
  readonly identity: IdentityResolution;
  readonly activeLineup: ActiveLineupResolution;
  readonly programSourceHealth: ReturnType<CstvSourceManagers['program']['getHealth']>;
  readonly lookaheadSourceHealth: ReturnType<CstvSourceManagers['lookahead']['getHealth']>;
}) {
  const { runtimeSnapshot, runtimeView, identity, activeLineup } = args;
  const lastTransition =
    runtimeSnapshot.recentTransitions[runtimeSnapshot.recentTransitions.length - 1];
  return {
    telemetryFreshness: args.telemetryFreshness,
    mapName: runtimeView.telemetry?.telemetry.map?.name ?? null,
    lastDispositionKind: runtimeSnapshot.lastDisposition?.kind ?? null,
    lastDispositionReason: runtimeSnapshot.lastDisposition?.reason ?? null,
    transitionsLength: runtimeSnapshot.recentTransitions.length,
    lastTransitionSeq: lastTransition?.runtimeSeq ?? null,
    seriesProgress: runtimeSnapshot.seriesProgress,
    contextBinding: args.contextBinding,
    identityState: identity.state,
    identityIssuesLen: identity.issues.length,
    identityResolvedCount: identity.players.filter((p) => p.canonicalPlayerId !== null).length,
    lineupState: activeLineup.state,
    lineupGen: activeLineup.sourceGeneration,
    lineupEpoch: activeLineup.mapEpoch,
    lineupCtCount: activeLineup.ct.length,
    lineupTCount: activeLineup.t.length,
    lineupExtrasCount: activeLineup.extras.length,
    programSourceState: args.programSourceHealth.state,
    programSourceGen: args.programSourceHealth.generation,
    programSourceTick:
      args.programSourceHealth.lastEventTick ?? args.programSourceHealth.tailTick ?? null,
    lookaheadSourceState: args.lookaheadSourceHealth.state,
    lookaheadSourceGen: args.lookaheadSourceHealth.generation,
    lookaheadSourceTick:
      args.lookaheadSourceHealth.lastEventTick ?? args.lookaheadSourceHealth.tailTick ?? null,
    producerInstanceId: runtimeView.cursor.producerInstanceId,
    liveSessionId: runtimeView.cursor.liveSessionId,
    programSourceGeneration: runtimeView.cursor.programSourceGeneration,
    mapEpoch: runtimeView.cursor.mapEpoch,
  };
}

function sameOperatorSemantic(
  prev: OperatorSemanticSnapshot | undefined,
  next: OperatorSemanticSnapshot,
): boolean {
  return prev !== undefined && shallowEqualRecord(prev, next);
}

function buildAssistSemanticSnapshot(args: {
  readonly program: ProgramProjection;
  readonly observerSettings:
    | {
        enabled: boolean;
        leadSeconds: number;
        delaySeconds: number;
        waitingForNextMap?: boolean;
      }
    | undefined;
  readonly lookaheadHealth: ReturnType<CstvSourceManagers['lookahead']['getHealth']>;
}) {
  return {
    enabled: args.observerSettings?.enabled ?? false,
    leadSeconds: args.observerSettings?.leadSeconds ?? 0,
    delaySeconds: args.observerSettings?.delaySeconds ?? 0,
    waitingForNextMap: args.observerSettings?.waitingForNextMap ?? false,
    lookaheadState: args.lookaheadHealth.state,
    lookaheadGen: args.lookaheadHealth.generation,
    lookaheadErrorCode: args.lookaheadHealth.lastErrorCode ?? null,
    lookaheadMapName: args.lookaheadHealth.mapName ?? null,
    mapName: args.program.map.name,
    roundNumber: args.program.map.roundNumber,
    roundPhase: args.program.round?.phase ?? null,
  };
}

function sameAssistSemantic(
  prev: AssistSemanticSnapshot | undefined,
  next: AssistSemanticSnapshot,
): boolean {
  return prev !== undefined && shallowEqualRecord(prev, next);
}

function sameAssistPayload(prev: AssistPayload | undefined, next: AssistPayload): boolean {
  return prev !== undefined && deepEqualArrayOrObj(prev, next);
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
