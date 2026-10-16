import { BusinessHistory } from './business-history.js';
import type { TelemetryObservation } from '@mizar/core/telemetry';
import type { MatchContextBinding } from '../match-context/index.js';
import type { ProjectionBundle } from '../projections/projection-coordinator.js';
import type { ReliableOutboxRecord } from '../output/reliable-outbox.js';

import {
  businessEvidence,
  businessVersion,
  steam64,
  object,
  version,
} from './business-evidence.js';
export { businessEvidence, BUSINESS_LOG_FILES } from './business-evidence.js';

/** Diagnostics observe existing decisions; they never authorize or replay output. */
export class BusinessJournal {
  private readonly history: BusinessHistory;
  private readonly sourceVersion: string;
  private previousRuntime = '';
  private readonly delivery = new Map<string, string>();
  constructor(directory: string, onFailure: () => void, sourceVersion?: string) {
    this.sourceVersion = version(sourceVersion) ?? businessVersion();
    this.history = new BusinessHistory(directory, onFailure, this.sourceVersion);
    this.write('business_session', {});
  }
  runtime(
    bundle: ProjectionBundle,
    binding: MatchContextBinding | undefined,
    observation?: TelemetryObservation,
  ): void {
    const { operator, program, identity } = bundle;
    const cursor = operator.cursor;
    const expected = binding
      ? Object.values(binding.context.entrants).flatMap((entry) =>
          entry.players.map((p) => ({
            steam64: p.steam64,
            entryId: entry.entryId,
            playerId: p.playerId,
            isStarter: p.isStarter,
          })),
        )
      : [];
    const resolvedObserved = [
      ...identity.players
        .filter((p) => p.evidence === 'current')
        .map((p) => ({
          steam64: p.steam64,
          entryId: p.entryId,
          playerId: p.canonicalPlayerId,
          side: p.side,
          slot: p.observerSlot,
        })),
      ...identity.unresolved.map((p) => ({
        steam64: p.sourcePlayerId,
        side: p.side,
        slot: p.observerSlot,
      })),
    ];
    const observed =
      observation?.telemetry.allPlayers?.map((p) => ({
        steam64: p.sourcePlayerId,
        side: p.side,
        slot: p.observerSlot,
        entryId: identity.players.find((i) => i.steam64 === p.sourcePlayerId)?.entryId,
      })) ?? resolvedObserved;
    const wanted = expected.filter((p) => p.isStarter && steam64(p.steam64)).map((p) => p.steam64!);
    const seen = observed.map((p) => p.steam64).filter((v): v is string => steam64(v) !== null);
    const evidence = businessEvidence({
      schema: 2,
      coverage: observation?.coverage,
      originalObservedAt: observation?.receive.receivedAt,
      mapPhase: program.map.phase,
      roundNumber: program.map.roundNumber,
      lineupState: operator.activeLineup.state,
      matchId: binding?.context.matchId,
      contextRevision: binding?.manifest.revision,
      competitionId: binding?.context.competition?.competitionId,
      liveSessionId: cursor.liveSessionId,
      producerInstanceId: cursor.producerInstanceId,
      mapName: operator.runtime.mapName,
      mapId: binding?.context.maps.find((m) => m.mapName === operator.runtime.mapName)?.mapId,
      scoreA: operator.seriesProgress?.score.a,
      scoreB: operator.seriesProgress?.score.b,
      scoreCT: program.map.score.ct,
      scoreT: program.map.score.t,
      mapEpoch: cursor.mapEpoch,
      sourceGeneration: cursor.programSourceGeneration,
      runtimeSeq: cursor.runtimeSeq,
      receiveSequence: cursor.programReceiveSequence,
      mapOrder: operator.seriesProgress?.currentMapOrder,
      context: operator.matchContext.freshness,
      identity: operator.identity.state,
      binding: program.series?.bindingState,
      telemetry: operator.runtime.telemetryFreshness,
      reason: operator.runtime.lastDisposition?.reason,
      expected,
      observed,
      rosterOmitted: Math.max(0, expected.length - 64) + Math.max(0, observed.length - 64),
      missing: wanted.filter((v) => !seen.includes(v)),
      extra: seen.filter((v) => !wanted.includes(v)),
      duplicates: [
        ...new Set(
          [...wanted, ...seen].filter(
            (v) =>
              wanted.filter((x) => x === v).length > 1 || seen.filter((x) => x === v).length > 1,
          ),
        ),
      ],
      issues: [...operator.identity.issues, ...(operator.seriesProgress?.issues ?? [])].map(
        (issue) => issue.code,
      ),
    });
    const signature = JSON.stringify({
      ...evidence,
      runtimeSeq: null,
      receiveSequence: null,
      originalObservedAt: null,
    });
    if (signature === this.previousRuntime) return;
    this.previousRuntime = signature;
    this.write('business_runtime', evidence);
  }
  reliable(record: ReliableOutboxRecord, reason: string): void {
    const { event } = record;
    const payload = object(event.payload);
    const evidence = businessEvidence({
      schema: 2,
      matchId: event.matchId,
      competitionId: event.competitionId,
      contextRevision: event.contextRevision,
      idempotencyKey: event.idempotencyKey,
      eventKind: event.kind,
      mapId: event.mapId,
      mapName: event.mapName,
      entryAId: event.entryAId,
      entryBId: event.entryBId,
      liveSessionId: event.cursor.liveSessionId,
      producerInstanceId: event.cursor.producerInstanceId,
      mapEpoch: event.cursor.mapEpoch,
      sourceGeneration: event.cursor.programSourceGeneration,
      runtimeSeq: event.cursor.runtimeSeq,
      receiveSequence: event.cursor.programReceiveSequence,
      originalObservedAt: event.observedAt,
      recordUpdatedAt: record.updatedAt,
      nextAttemptAt: record.nextAttemptAt,
      ...(reason === 'restored'
        ? { restoredAt: new Date().toISOString(), restoredVersion: this.sourceVersion }
        : {}),
      ...event.evidence,
      ...payload,
      status: record.status,
      attempts: record.attempts,
      reason,
    });
    const key = evidence.idempotencyKey ?? '';
    const signature = JSON.stringify(evidence);
    if (this.delivery.get(key) === signature) return;
    this.delivery.delete(key);
    this.delivery.set(key, signature);
    if (this.delivery.size > 192) this.delivery.delete(this.delivery.keys().next().value!);
    this.write('business_delivery', evidence);
  }
  write(stage: string, evidence: unknown): void {
    this.history.append(stage, businessEvidence({ ...object(evidence), schema: 2 }));
  }
  flush(): Promise<void> {
    return this.history.flush();
  }
  close(): Promise<void> {
    return this.history.close();
  }
  getHealth() {
    return this.history.getHealth();
  }
  getStatus(): 'available' | 'write_failed' {
    return this.history.getStatus();
  }
}
