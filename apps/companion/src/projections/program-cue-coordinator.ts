import { projectProgramCue, type RoleScopedGameEventObservation } from '@mizar/core/game-events';
import type { RuntimeReduceResult } from '@mizar/core/runtime';
import type { ProgramSourceFreshness } from '@mizar/core/runtime';
import { LOCAL_PROTOCOL_VERSION, PROGRAM_CUE_SCHEMA_VERSION } from '@mizar/protocol/version';
import type { ProgramCueLaneCursor } from '@mizar/protocol/program-cue';

import {
  createProgramCuePublisher,
  type ProgramCuePublisher,
} from '../local-protocol/program-cue-publisher.js';
import { mapProgramCue } from '../local-protocol/program-cue-wire.js';
import type { ProgramRuntime, ProgramRuntimeSnapshot } from '../runtime/program-runtime.js';
import type { CstvSourceManager } from '../telemetry/cstv-source-manager.js';

export interface ProgramCueCoordinatorOptions {
  readonly programSource: CstvSourceManager<'program'>;
  readonly programRuntime: Pick<ProgramRuntime, 'getSnapshot' | 'getSourceFreshness'>;
  readonly publisher?: ProgramCuePublisher;
  readonly nowMonotonicMs?: () => number;
  readonly onDiagnostic?: (diagnostic: { readonly code: string }) => void;
}

export interface ProgramCueCoordinator {
  afterRuntimeMutation(result?: RuntimeReduceResult): void;
  getPublisher(): ProgramCuePublisher;
  close(): Promise<void>;
}

interface RuntimeCueContext {
  readonly producerInstanceId: string;
  readonly liveSessionId: string | null;
  readonly mapEpoch: number;
  readonly mapName: string | undefined;
  readonly programSourceGeneration: number;
}

function report(
  onDiagnostic: ((diagnostic: { readonly code: string }) => void) | undefined,
  code: string,
): void {
  try {
    onDiagnostic?.({ code });
  } catch {
    // Cue diagnostics must not interrupt the live source callback.
  }
}

function liveSessionId(snapshot: ProgramRuntimeSnapshot): string | null {
  return snapshot.current.liveSession.kind === 'bound'
    ? snapshot.current.liveSession.liveSessionId
    : null;
}

function contextFrom(runtimeSnapshot: ProgramRuntimeSnapshot): RuntimeCueContext {
  return {
    producerInstanceId: runtimeSnapshot.current.producerInstanceId,
    liveSessionId: liveSessionId(runtimeSnapshot),
    mapEpoch: runtimeSnapshot.current.map.epoch,
    mapName: runtimeSnapshot.current.map.name,
    programSourceGeneration: runtimeSnapshot.current.programSource.generation,
  };
}

function sameLaneCursor(
  left: ProgramCueLaneCursor | undefined,
  right: ProgramCueLaneCursor,
): boolean {
  return (
    left !== undefined &&
    left !== null &&
    left.producerInstanceId === right.producerInstanceId &&
    left.liveSessionId === right.liveSessionId &&
    left.mapEpoch === right.mapEpoch &&
    left.cstvProgramGeneration === right.cstvProgramGeneration
  );
}

class DefaultProgramCueCoordinator implements ProgramCueCoordinator {
  private readonly programSource: CstvSourceManager<'program'>;
  private readonly programRuntime: Pick<ProgramRuntime, 'getSnapshot' | 'getSourceFreshness'>;
  private readonly publisher: ProgramCuePublisher;
  private readonly nowMonotonicMs: () => number;
  private readonly onDiagnostic: ((diagnostic: { readonly code: string }) => void) | undefined;
  private readonly sourceUnsubscribers: readonly (() => void)[];
  private lastSourceState: ReturnType<CstvSourceManager<'program'>['getHealth']>['state'];
  private lastObservedSourceSequence:
    { readonly generation: number; readonly sequence: number } | undefined;
  private closed = false;

  constructor(options: ProgramCueCoordinatorOptions) {
    this.programSource = options.programSource;
    this.programRuntime = options.programRuntime;
    this.nowMonotonicMs =
      options.nowMonotonicMs ?? (() => globalThis.performance?.now() ?? Date.now());
    this.onDiagnostic = options.onDiagnostic;
    this.publisher =
      options.publisher ??
      createProgramCuePublisher({
        id: 'program-cue',
        onDiagnostic: (diagnostic) => report(this.onDiagnostic, `program-cue-${diagnostic.code}`),
        nowMonotonicMs: this.nowMonotonicMs,
      });
    this.lastSourceState = this.programSource.getHealth().state;
    this.publishBaselineIfNeeded(true);
    this.sourceUnsubscribers = [
      this.programSource.subscribe(() => this.handleSourceHealthChanged()),
      this.programSource.subscribeLiveGameEvents((event) => this.handleObservation(event)),
    ];
  }

  afterRuntimeMutation(): void {
    if (this.closed) return;
    this.publishBaselineIfNeeded();
  }

  getPublisher(): ProgramCuePublisher {
    return this.publisher;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const unsubscribe of this.sourceUnsubscribers) unsubscribe();
    await this.publisher.close();
  }

  private publishBaselineIfNeeded(force = false): void {
    if (this.closed) return;
    const runtimeSnapshot = this.programRuntime.getSnapshot();
    const context = contextFrom(runtimeSnapshot);
    const sourceGeneration = this.programSource.getHealth().generation;
    const cursor = {
      producerInstanceId: context.producerInstanceId,
      liveSessionId: context.liveSessionId,
      mapEpoch: context.mapEpoch,
      cstvProgramGeneration: sourceGeneration,
    } as const;
    const current = this.publisher.getCurrent();
    const runtimeContinuityChanged =
      current !== null &&
      (current.cursor.producerInstanceId !== context.producerInstanceId ||
        current.cursor.liveSessionId !== context.liveSessionId ||
        current.cursor.mapEpoch !== context.mapEpoch ||
        context.programSourceGeneration !== this.lastPublishedProgramSourceGeneration);
    if (
      !force &&
      current !== null &&
      !runtimeContinuityChanged &&
      sameLaneCursor(current.cursor, cursor)
    ) {
      return;
    }
    this.publisher.publishBaseline({
      type: 'cue-baseline',
      protocolVersion: LOCAL_PROTOCOL_VERSION,
      channel: 'program-cue',
      schemaVersion: PROGRAM_CUE_SCHEMA_VERSION,
      cursor,
    });
    this.lastPublishedProgramSourceGeneration = context.programSourceGeneration;
  }

  private handleSourceHealthChanged(): void {
    const nextState = this.programSource.getHealth().state;
    const sourceStopped = this.lastSourceState === 'live' && nextState !== 'live';
    this.lastSourceState = nextState;
    this.publishBaselineIfNeeded(sourceStopped);
  }

  private handleObservation(observation: RoleScopedGameEventObservation<'program'>): void {
    if (this.closed) return;
    this.publishBaselineIfNeeded();
    const runtimeSnapshot = this.programRuntime.getSnapshot();
    const context = contextFrom(runtimeSnapshot);
    const health = this.programSource.getHealth();
    if (health.state !== 'live') {
      report(this.onDiagnostic, 'program-cue-source-not-live');
      return;
    }
    if (
      observation.cursor.role !== 'program' ||
      observation.cursor.generation !== health.generation
    ) {
      report(this.onDiagnostic, 'program-cue-source-generation-mismatch');
      return;
    }
    if (
      this.lastObservedSourceSequence !== undefined &&
      this.lastObservedSourceSequence.generation === observation.cursor.generation &&
      observation.cursor.sequence <= this.lastObservedSourceSequence.sequence
    ) {
      report(
        this.onDiagnostic,
        observation.cursor.sequence === this.lastObservedSourceSequence.sequence
          ? 'program-cue-source-duplicate'
          : 'program-cue-source-out-of-order',
      );
      return;
    }
    this.lastObservedSourceSequence = {
      generation: observation.cursor.generation,
      sequence: observation.cursor.sequence,
    };

    let freshness: ProgramSourceFreshness;
    try {
      freshness = this.programRuntime.getSourceFreshness(this.nowMonotonicMs());
    } catch {
      report(this.onDiagnostic, 'program-cue-freshness-unavailable');
      return;
    }
    if (freshness !== 'fresh') {
      report(this.onDiagnostic, `program-cue-telemetry-${freshness}`);
      return;
    }
    if (context.mapEpoch <= 0) {
      report(this.onDiagnostic, 'program-cue-map-not-established');
      return;
    }
    if (
      observation.cursor.mapName !== undefined &&
      context.mapName !== undefined &&
      observation.cursor.mapName !== context.mapName
    ) {
      report(this.onDiagnostic, 'program-cue-map-mismatch');
      return;
    }

    const cue = projectProgramCue({
      observation,
      producerInstanceId: context.producerInstanceId,
      mapEpoch: context.mapEpoch,
    });
    if (cue === null) {
      const targetMissing =
        observation.kind === 'player-death'
          ? observation.victim.sourcePlayerId === undefined ||
            observation.victim.sourcePlayerId.trim().length === 0
          : observation.kind === 'player-hurt' &&
            (observation.victim.sourcePlayerId === undefined ||
              observation.victim.sourcePlayerId.trim().length === 0);
      report(
        this.onDiagnostic,
        targetMissing ? 'program-cue-player-id-missing' : 'program-cue-not-applicable',
      );
      return;
    }
    this.publisher.publishCue({
      type: 'cue',
      protocolVersion: LOCAL_PROTOCOL_VERSION,
      channel: 'program-cue',
      schemaVersion: PROGRAM_CUE_SCHEMA_VERSION,
      cursor: {
        producerInstanceId: context.producerInstanceId,
        liveSessionId: context.liveSessionId,
        mapEpoch: context.mapEpoch,
        cstvProgramGeneration: observation.cursor.generation,
      },
      cue: mapProgramCue(cue),
    });
  }

  private lastPublishedProgramSourceGeneration: number | undefined;
}

export function createProgramCueCoordinator(
  options: ProgramCueCoordinatorOptions,
): ProgramCueCoordinator {
  return new DefaultProgramCueCoordinator(options);
}
