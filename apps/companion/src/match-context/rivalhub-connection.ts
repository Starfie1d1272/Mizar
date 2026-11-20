import { RepeatedDiagnostic } from '../support/repeated-diagnostic.js';
import { diagnosticValue } from '../support/session-journal.js';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import type { MatchSourceRecovery } from '@mizar/protocol/operator';
import type { LiveSnapshotV1, ReliableEventV1 } from '@mizar/protocol/output';
import {
  RivalHubAuthorization,
  OFFICIAL_RIVALHUB_URL,
  type Installation,
} from './rivalhub-authorization.js';
import { RivalHubReadClient, type StatsTarget } from './rivalhub-read-client.js';
import {
  requestFailureReason,
  requestFailureCode,
  readReliableBody,
} from './rivalhub-http-errors.js';
import type { ReliableDeliveryResult } from '../output/reliable-delivery.js';
import { SerialCommitQueue } from './serial-commit.js';
import {
  RivalHubEventTransport,
  type RivalHubTransportSource,
} from './rivalhub-event-transport.js';
import type { CaptureReference } from '../output/capture-interval.js';
import {
  RivalHubSourceState,
  exactKey,
  matchKey,
  sameExactSource,
  sameInstallationScope,
  sameScope,
  type ExactSource,
  type ClaimIntent,
  type SourceScope,
} from './rivalhub-source-state.js';
import {
  canCheckBlockedSource,
  claimRecoveryProof,
  confirmsClosedSource,
  definitiveClaimRejection,
  executionKey,
  releaseRetry,
  serverRetryAt,
  sourceStatusRequest,
} from './rivalhub-source-recovery.js';

export { OFFICIAL_RIVALHUB_URL } from './rivalhub-authorization.js';
export { statsTarget, type StatsTarget } from './rivalhub-read-client.js';

export interface SourceCaptureLifecycle {
  createReference(cursor: ReliableEventV1['cursor']): CaptureReference;
  arm(identity: ExactSource, reference: CaptureReference): Promise<void>;
  activate(identity: ExactSource): void;
  restore(identity: ExactSource, reference: CaptureReference | undefined): Promise<void>;
  seal(identity: ExactSource): Promise<boolean>;
  coverage(identity: ExactSource): {
    state: 'armed' | 'sealed' | 'unknown';
    durableUnknown?: boolean;
  };
}

type Source = RivalHubTransportSource;

/** Companion-owned scoped installation. Never exposed to the browser. */
export class RivalHubConnection {
  private onDiagnostic: (operation: string, error: unknown) => void = () => {};
  setDiagnosticHandler(handler: (operation: string, error: unknown) => void): void {
    this.onDiagnostic = (operation, error) => {
      try {
        handler(operation, error);
      } catch {
        // Diagnostic observers cannot turn retained website failures into uncaught errors.
      }
    };
  }
  private businessHandler: ((stage: string, evidence: unknown) => void) | undefined;
  private originalError(operation: string, error: unknown): void {
    try {
      this.businessHandler?.('original_error', {
        operation,
        error: diagnosticValue(error, '', new Set(), this.authorization.redactionValues()),
      });
    } catch {
      /* Diagnostic observers cannot change transport or authorization. */
    }
  }
  setBusinessEvidenceHandler(handler: (stage: string, evidence: unknown) => void): void {
    this.businessHandler = handler;
  }
  private readonly unavailableLive = new RepeatedDiagnostic((stage, evidence) => {
    try {
      this.businessHandler?.(stage, evidence);
    } catch {
      /* Diagnostics cannot affect delivery. */
    }
  });
  private business(
    stage: string,
    snapshot: {
      matchId: string;
      cursor: LiveSnapshotV1['cursor'];
      competitionId?: string;
      contextRevision?: string;
      observedAt?: string;
    },
    evidence: Record<string, unknown>,
  ) {
    try {
      const detail = {
        matchId: snapshot.matchId,
        competitionId: snapshot.competitionId,
        contextRevision: snapshot.contextRevision,
        originalObservedAt: snapshot.observedAt,
        authorityRevision: this.source?.authorityRevision,
        liveSessionId: snapshot.cursor.liveSessionId,
        producerInstanceId: snapshot.cursor.producerInstanceId,
        mapEpoch: snapshot.cursor.mapEpoch,
        sourceGeneration: snapshot.cursor.programSourceGeneration,
        ...evidence,
      };
      if (stage === 'business_live') {
        if (evidence.reason === 'source_unavailable' || evidence.reason === 'map_start_pending') {
          this.unavailableLive.record(
            stage,
            JSON.stringify({ ...detail, originalObservedAt: null }),
            detail,
          );
          return;
        }
        this.unavailableLive.clear();
      }
      this.businessHandler?.(stage, detail);
    } catch {
      /* Diagnostics cannot affect authorization or delivery. */
    }
  }
  private source: Source | null = null;
  private readonly sourceSettlements = new Map<string, Promise<boolean>>();
  private cleanupCursor = 0;
  private readonly blockedStatusRetryAt = new Map<string, number>();
  private readonly cleanupAttempts = new Map<string, { count: number; nextCycleAt: number }>();
  private readonly confirmedSourcesAwaitingPersistence = new Map<string, ExactSource>();
  private readonly exitHandoffs = new Map<
    string,
    { identity: ExactSource; cause: 'finish' | 'switch' | 'recovery' | 'shutdown' }
  >();
  private readonly sourceCommands = new SerialCommitQueue();
  private readonly handoffCommits = new SerialCommitQueue();
  private automaticClaimAttempts: {
    installation: Installation;
    target: string;
    count: number;
  } | null = null;
  private readonly sourceState: RivalHubSourceState;
  private intentReconcileCursor = 0;
  private readonly intentRetry = new Map<string, { attempts: number; nextAt: number }>();
  private cleanupTimer: ReturnType<typeof setInterval> | undefined;
  private cleanupScheduled = false;
  private cleanupSummary = { pending: 0, blocked: 0, claimIntent: false, coverageUnknown: 0 };
  private cleanupMatches = new Map<string, 'remote_cleanup' | 'retained'>();
  private settleSource: ((scope: SourceScope) => Promise<boolean>) | undefined;
  private archiveSource:
    ((identity: ExactSource, disposition?: 'revoked') => Promise<void>) | undefined;
  private activeReliableSources: (() => readonly ExactSource[]) | undefined;
  private readonly isolatedRevokedSources = new Map<string, ExactSource>();
  private readonly revokedIsolationRetry = new Map<
    string,
    { identity: ExactSource; retryAt: number }
  >();
  private resumeSource: ((scope: SourceScope) => void) | undefined;
  private bindingGeneration = 0;
  private activeDeviceName: string | null = null;
  private activeDeviceMatchId: string | null = null;
  private claimRevision = 0;
  private stoppedMatchId: string | null = null;
  private readonly eventTransport = new RivalHubEventTransport({
    authorization: {
      request: (path, init) => this.authorization.request(path, init),
    },
    fetchImpl: (...args) => this.fetchImpl(...args),
    canSendRetainedReliable: async (identity) => {
      const state = await this.sourceState.snapshot();
      const key = exactKey(identity);
      const record = state.records.find((item) => sameExactSource(item.identity, identity));
      return Boolean(
        record &&
        ['owned', 'release_pending'].includes(record.state) &&
        !record.installationRevoked &&
        !record.quarantineUncertain &&
        !this.confirmedSourcesAwaitingPersistence.has(key),
      );
    },
    isRetainedSourceActive: (identity) => {
      const key = exactKey(identity);
      return (
        !this.isolatedRevokedSources.has(key) && !this.confirmedSourcesAwaitingPersistence.has(key)
      );
    },
    installation: () => this.installation,
    source: () => this.source,
    stoppedMatchId: () => this.stoppedMatchId,
    monotonicNow: () => this.monotonicNow(),
    requireSourceState: () => this.requireSourceState(),
    isCurrentInstallation: (scope) => this.isCurrentInstallation(scope),
    business: (stage, payload, fields) => this.business(stage, payload, fields),
    onDiagnostic: (operation, error) => this.onDiagnostic(operation, error),
    originalError: (operation, error) => this.originalError(operation, error),
    failureExecutionKey: (payload) => this.failureExecutionKey(payload),
  });
  private failureExecutionKey(snapshot: {
    matchId: string;
    cursor: LiveSnapshotV1['cursor'];
  }): string {
    return JSON.stringify([snapshot.matchId, executionKey(snapshot.cursor), this.claimRevision]);
  }
  private syncWatch: {
    key: string;
    matchId: string;
    since: number;
    incidentId: string | null;
  } | null = null;
  private boundaryStatus:
    (() => 'continuity_chain_missing' | 'continuity_waiting' | null) | undefined;
  setBoundaryStatusProvider(
    provider: () => 'continuity_chain_missing' | 'continuity_waiting' | null,
  ): void {
    this.boundaryStatus = provider;
  }

  /** Operator-only projection. A claim or a reliable ACK is never LIVE acceptance. */
  syncHealth(
    snapshot: LiveSnapshotV1 | null,
    expected: boolean,
    matchId = snapshot?.matchId ?? null,
  ) {
    const result = (status: string, reason: string | null = null) => ({
      status,
      reason,
      incidentId: this.syncWatch?.incidentId ?? null,
      deviceName: this.activeDeviceName,
    });
    if (matchId && this.syncWatch?.matchId !== matchId) this.syncWatch = null;
    if (!this.installation) {
      this.syncWatch = null;
      return result('inactive');
    }
    // Hiding the workspace or entering preparation is not receiver recovery.
    // Preserve the incident acknowledgement until acceptance or a new execution.
    if (!expected) return result('inactive');
    if (matchId && this.stoppedMatchId === matchId) return result('stopped');
    if (this.activeDeviceName && this.activeDeviceMatchId === matchId)
      return result('other_device');
    const controlFailure = snapshot
      ? this.eventTransport.controlFailureFor(this.failureExecutionKey(snapshot))
      : null;
    // Only a current, bound formal execution can start a watch. Warmup and
    // unbound practice/demo inputs never establish an expected website stream.
    if (snapshot && snapshot.map.phase !== 'live') {
      this.syncWatch = null;
      return result('inactive', controlFailure);
    }
    if (
      snapshot?.map.phase === 'live' &&
      snapshot.map.mapId &&
      snapshot.cursor.liveSessionId &&
      snapshot.capability.canonicalTeams &&
      snapshot.capability.lineupComplete
    ) {
      const key = JSON.stringify([snapshot.matchId, executionKey(snapshot.cursor)]);
      if (this.syncWatch?.key !== key)
        this.syncWatch = {
          key,
          matchId: snapshot.matchId,
          since: this.monotonicNow(),
          incidentId: null,
        };
    }
    const watch = this.syncWatch;
    if (!watch) return result('inactive', controlFailure);
    const now = this.monotonicNow();
    const liveStatus = snapshot
      ? this.eventTransport.liveStatusForCursor(executionKey(snapshot.cursor), now)
      : null;
    const current = Boolean(
      snapshot &&
      this.source?.matchId === snapshot.matchId &&
      this.source.deliveryExecution === executionKey(snapshot.cursor) &&
      liveStatus?.matchesCursor,
    );
    const boundaryStatus = this.boundaryStatus?.() ?? null;
    if (!boundaryStatus && current && liveStatus?.recentlyAccepted) {
      watch.since = now;
      watch.incidentId = null;
      return result('healthy');
    }
    const reason =
      boundaryStatus ??
      controlFailure ??
      (!snapshot
        ? 'input_unavailable'
        : !this.source
          ? 'source_unavailable'
          : current
            ? (liveStatus?.reason ?? 'reception_unconfirmed')
            : 'map_start_pending');
    if (now - watch.since < 15_000 && !watch.incidentId) return result('waiting', reason);
    watch.incidentId ??= randomUUID();
    return result('attention', reason);
  }

  setContextRecoveryProgress(
    event: ReliableEventV1,
    authority: string,
    state:
      | 'context_refreshing'
      | 'context_reconfirming'
      | 'context_recovery_blocked'
      | 'continuity_chain_missing'
      | 'continuity_waiting',
  ): void {
    if (this.reliableAuthorityScope() !== authority || this.stoppedMatchId === event.matchId)
      return;
    this.eventTransport.setControlFailure(this.failureExecutionKey(event), state);
  }

  retryLive(): void {
    this.eventTransport.resetLiveBackoff();
  }

  hasCurrentStart(snapshot: LiveSnapshotV1): boolean {
    return (
      this.source?.matchId === snapshot.matchId &&
      this.source.acknowledgedExecution === executionKey(snapshot.cursor)
    );
  }

  stopSync(matchId: string | null): void {
    ++this.bindingGeneration;
    this.stoppedMatchId = matchId;
    this.syncWatch = null;
    if (this.source && (!matchId || this.source.matchId === matchId)) {
      this.source.draining = true;
      this.source.paused = true;
      this.sealCapture(this.sourceIdentity(this.source));
    }
  }

  /** Local delivery identity only; never includes installation credentials. */
  reliableAuthorityScope(): string | null {
    return this.source === null
      ? null
      : JSON.stringify([
          this.source.baseUrl,
          this.source.competitionId,
          this.source.installationId,
          this.source.matchId,
          this.source.authorityRevision,
          this.source.producerInstanceId,
          this.source.liveSessionId,
          this.claimRevision,
        ]);
  }

  reliableExactSource(): ExactSource | undefined {
    return this.source && this.installation ? this.sourceIdentity(this.source) : undefined;
  }

  private readonly authorization: RivalHubAuthorization;
  private readonly readClient: RivalHubReadClient;

  private get installation() {
    return this.authorization.installation;
  }

  constructor(
    path: string,
    private readonly fetchImpl: typeof fetch = fetch,
    baseUrl = OFFICIAL_RIVALHUB_URL,
    private readonly monotonicNow = () => performance.now(),
  ) {
    this.sourceState = new RivalHubSourceState(join(dirname(path), 'rivalhub-source-state.json'));
    this.authorization = new RivalHubAuthorization(
      path,
      fetchImpl,
      baseUrl,
      (operation) => this.sourceCommands.run(operation),
      async () => {
        this.requireSourceState();
        await this.retireCurrent('switch');
        // Persist the old responsibility before replacing credentials. A revoked
        // credential cannot confirm release and must not prevent reauthorization.
        await this.cleanup(false);
      },
      () => {
        this.source = null;
        this.readClient.invalidate();
      },
      (operation, error) => this.onDiagnostic(operation, error),
      (operation, error) => this.originalError(operation, error),
    );
    this.readClient = new RivalHubReadClient(
      path,
      fetchImpl,
      () => this.installation,
      (operation, init) => this.authorization.request(operation, init),
      (response) => this.authorization.readJson(response),
      monotonicNow,
      (installation, viewer) => this.authorization.rememberViewer(installation, viewer),
      (operation, evidence) => this.onDiagnostic(operation, evidence),
    );
  }

  startPairing() {
    return this.authorization.startPairing();
  }
  pollPairing() {
    return this.authorization.pollPairing();
  }

  getSchedule() {
    return this.readClient.getSchedule();
  }
  schedule(from: string, to: string) {
    return this.readClient.schedule(from, to);
  }
  automaticManifestDeferred(matchId: string) {
    return this.readClient.automaticManifestDeferred(matchId);
  }
  library() {
    return this.readClient.library();
  }
  libraryDetail(matchId: string, fresh = true) {
    return this.readClient.libraryDetail(matchId, fresh);
  }
  matchSource(matchId: string, fresh = true) {
    return this.readClient.matchSource(matchId, fresh);
  }
  stats(target: StatsTarget | null, refresh = false) {
    return this.readClient.stats(target, refresh);
  }
  clearStats() {
    this.readClient.clearStats();
  }
  statsFetchedAt(target: StatsTarget | null) {
    return this.readClient.statsFetchedAt(target);
  }
  getStatsSnapshot(target: StatsTarget | null) {
    return this.readClient.getStatsSnapshot(target);
  }
  getStats(target: StatsTarget | null) {
    return this.readClient.getStats(target);
  }

  private sourceStateAvailable = false;
  private captureLifecycle: SourceCaptureLifecycle | undefined;

  async setSourceCaptureLifecycle(lifecycle: SourceCaptureLifecycle): Promise<void> {
    this.captureLifecycle = lifecycle;
    if (!this.sourceStateAvailable) return;
    try {
      const state = await this.sourceState.snapshot();
      for (const record of state.records)
        await lifecycle.restore(record.identity, record.captureReference);
      await this.updateCleanupSummary();
    } catch (error) {
      this.sourceStateAvailable = false;
      throw error;
    }
  }

  private sealCapture(identity: ExactSource): void {
    // The lifecycle fences synchronously, before any JSON/network await.
    try {
      void this.captureLifecycle
        ?.seal(identity)
        .catch((error: unknown) => this.onDiagnostic('source_capture_seal', error));
    } catch (error) {
      this.onDiagnostic('source_capture_seal', error);
    }
  }

  private async confirmedCapture(identity: ExactSource): Promise<CaptureReference | undefined> {
    const state = await this.sourceState.snapshot();
    return state.records.find((record) => sameExactSource(record.identity, identity))
      ?.captureReference;
  }

  private async restoreConfirmedCapture(identity: ExactSource): Promise<void> {
    if (!this.captureLifecycle) return;
    await this.captureLifecycle.restore(identity, await this.confirmedCapture(identity));
  }

  private requireSourceState(): void {
    if (!this.sourceStateAvailable) throw new Error('rivalhub_source_state_unavailable');
  }

  /** Startup rollback only; recovery requires a new owner on the next start. */
  async abortSourceCaptureStartup(): Promise<void> {
    this.sourceStateAvailable = false;
    this.unavailableLive.clear();
    ++this.bindingGeneration;
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.cleanupTimer = undefined;
    await this.sourceCommands.run(() => this.sourceState.close());
  }

  async load(): Promise<void> {
    this.sourceStateAvailable = false;
    try {
      await this.sourceState.load();
      await this.sourceState.recover();
      await this.updateCleanupSummary();
      this.sourceStateAvailable = true;
    } catch (error) {
      this.sourceState.invalidate();
      this.onDiagnostic('source_state_load', error);
      try {
        await this.sourceState.close();
      } catch (cleanupError) {
        this.onDiagnostic('source_state_startup_cleanup', cleanupError);
      }
    }
    await this.authorization.load((installation) => this.readClient.invalidate(installation));
  }

  view() {
    return {
      paired: this.installation !== null,
      competitionId: this.installation?.competitionId ?? null,
      displayName: this.installation?.displayName ?? null,
      authorizedUser: this.installation?.authorizedUser ?? null,
      scheduleWarning: this.readClient.scheduleWarning,
      activeSourceMatchId: this.source?.matchId ?? null,
      activeDeviceName: this.activeDeviceName,
      activeDeviceMatchId: this.activeDeviceMatchId,
      pairing: this.authorization.pairing,
      stoppedMatchId: this.stoppedMatchId,
      sourceState: this.sourceStateAvailable ? 'ready' : 'unavailable',
      sourceCleanup: { ...this.cleanupSummary, handoffPending: this.exitHandoffs.size },
      liveDelivery:
        this.source === null
          ? { status: 'idle', cursor: null, reason: null, consecutiveUnaccepted: 0, durationMs: 0 }
          : this.eventTransport.liveDeliveryView(this.monotonicNow()),
    };
  }

  setSourceSettlement(
    settle: (scope: SourceScope) => Promise<boolean>,
    resume: (scope: SourceScope) => void,
    archive?: (identity: ExactSource, disposition?: 'revoked') => Promise<void>,
    activeSources?: () => readonly ExactSource[],
  ): void {
    this.settleSource = settle;
    this.resumeSource = resume;
    this.archiveSource = archive;
    this.activeReliableSources = activeSources;
  }

  startSourceCleanup(): void {
    if (!this.sourceStateAvailable || this.cleanupTimer) return;
    this.cleanupTimer = setInterval(() => this.scheduleSourceCleanup(), 10_000);
    this.cleanupTimer.unref();
    this.scheduleSourceCleanup();
  }

  private scheduleSourceCleanup(): void {
    if (!this.sourceStateAvailable || this.shutdownSignal?.aborted || this.cleanupScheduled) return;
    this.cleanupScheduled = true;
    void this.sourceCommands
      .run(() => this.cleanup(false))
      .catch((error: unknown) => this.onDiagnostic('source_cleanup', error))
      .finally(() => {
        this.cleanupScheduled = false;
      });
  }

  bindingChanged(matchId: string | null): void {
    const generation = ++this.bindingGeneration;
    if (this.source && this.source.matchId !== matchId) {
      this.source.draining = true;
      this.source.paused = true;
      this.sealCapture(this.sourceIdentity(this.source));
    }
    void this.sourceCommands
      .run(async () => {
        if (
          generation !== this.bindingGeneration ||
          !this.source ||
          this.source.matchId === matchId
        )
          return;
        await this.retireCurrent('switch');
        await this.cleanup(false);
      })
      .catch((error: unknown) => this.onDiagnostic('source_switch', error));
  }

  /** Flush local observations after delivery stops, before the journal closes. */
  flushDiagnostics(): void {
    this.unavailableLive.clear();
  }

  private shutdownSignal: AbortSignal | undefined;

  async prepareSourceShutdown(): Promise<void> {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.cleanupTimer = undefined;
    if (!this.sourceStateAvailable && !this.source && !this.exitHandoffs.size) return;
    await this.freezeExitSource('shutdown');
  }

  async shutdownSource(signal: AbortSignal): Promise<void> {
    if (!this.sourceStateAvailable) return;
    this.shutdownSignal = signal;
    await this.sourceCommands.run(async () => {
      signal.throwIfAborted();
      await this.cleanup(true, Date.now() + 8000);
      signal.throwIfAborted();
    });
  }

  async closeSourceState(): Promise<void> {
    this.sourceStateAvailable = false;
    clearInterval(this.cleanupTimer);
    this.cleanupTimer = undefined;
    await this.handoffCommits.flush();
    this.unavailableLive.clear();
    await this.sourceState.close();
  }

  private cleanupRequestSignal(deadline: number): AbortSignal {
    const timeout = AbortSignal.timeout(Math.max(1, Math.min(4000, deadline - Date.now())));
    return this.shutdownSignal ? AbortSignal.any([this.shutdownSignal, timeout]) : timeout;
  }

  private async updateCleanupSummary(): Promise<void> {
    const state = await this.sourceState.snapshot();
    const cleanupMatches = new Map<string, 'remote_cleanup' | 'retained'>();
    for (const record of state.records) {
      if (record.state === 'owned') continue;
      const key = matchKey(record.identity);
      if (record.state === 'blocked' && !canCheckBlockedSource(record, false)) {
        if (!cleanupMatches.has(key)) cleanupMatches.set(key, 'retained');
      } else {
        cleanupMatches.set(key, 'remote_cleanup');
      }
    }
    for (const { scope } of state.intents) cleanupMatches.set(matchKey(scope), 'remote_cleanup');
    this.cleanupSummary = {
      pending: state.records.filter((item) =>
        ['release_pending', 'archive_pending'].includes(item.state),
      ).length,
      blocked:
        state.records.filter((item) => item.state === 'blocked').length +
        state.revokedIntents.length +
        (await this.sourceState.quarantineCount()),
      claimIntent: state.intents.length > 0,
      coverageUnknown: state.records.filter(
        (record) => this.captureLifecycle?.coverage(record.identity).state === 'unknown',
      ).length,
    };
    this.cleanupMatches = cleanupMatches;
  }

  matchSourceRecovery(matchId: string): MatchSourceRecovery {
    if (!this.installation) return 'idle';
    const key = matchKey({ ...this.installation, matchId });
    if ([...this.exitHandoffs.values()].some(({ identity }) => matchKey(identity) === key))
      return 'local_handoff';
    return this.cleanupMatches.get(key) ?? 'idle';
  }

  private async hasOutstandingReleaseWork(): Promise<boolean> {
    const state = await this.sourceState.snapshot();
    return (
      state.records.some(
        (item) =>
          item.state !== 'owned' &&
          (this.isCurrentInstallation(item.identity) ||
            (item.state !== 'archive_pending' && !item.installationRevoked)),
      ) || state.intents.length > 0
    );
  }

  private cleanupEvidence(identity: ExactSource, reason: string, attempts: number): void {
    try {
      this.businessHandler?.('business_source_cleanup', {
        matchId: identity.matchId,
        competitionId: identity.competitionId,
        installationId: identity.installationId,
        producerInstanceId: identity.producerInstanceId,
        liveSessionId: identity.liveSessionId,
        authorityRevision: identity.authorityRevision,
        reason,
        attempts,
      });
    } catch {
      /* Diagnostics cannot change cleanup. */
    }
  }

  private isCurrentInstallation(scope: SourceScope): boolean {
    return this.installation !== null && sameInstallationScope(scope, this.installation);
  }

  private sourceIdentity(source: Source): ExactSource {
    return {
      baseUrl: source.baseUrl,
      competitionId: source.competitionId,
      installationId: source.installationId,
      matchId: source.matchId,
      producerInstanceId: source.producerInstanceId,
      liveSessionId: source.liveSessionId,
      authorityRevision: source.authorityRevision,
    };
  }

  private async settle(identity: ExactSource, budgetMs = 2500): Promise<boolean> {
    if (!this.settleSource) return false;
    const key = exactKey(identity);
    const drain = async () => {
      // The output owner fences new events synchronously on entry. Only after
      // that fence exists may a paused source deliver its already queued tail.
      const disposition = this.settleSource!(identity).catch(() => false);
      const source = this.source;
      if (source?.draining && sameExactSource(source, identity)) source.drainReliable = true;
      await this.eventTransport.awaitLiveInFlight(identity);
      return disposition;
    };
    let operation = this.sourceSettlements.get(key);
    if (!operation) {
      operation = drain().catch(() => false);
      this.sourceSettlements.set(key, operation);
      void operation.then(() => {
        if (this.sourceSettlements.get(key) === operation) this.sourceSettlements.delete(key);
      });
    }
    return Promise.race([
      operation,
      new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), Math.max(1, budgetMs));
        timer.unref();
      }),
    ]);
  }

  private async retireCurrent(cause: 'finish' | 'switch' | 'shutdown'): Promise<void> {
    const source = this.source;
    if (!source) return;
    const identity = this.sourceIdentity(source);
    source.draining = true;
    source.paused = true;
    this.sealCapture(identity);
    await this.sourceState.handoff(identity, cause);
    await this.updateCleanupSummary();
    // Durable handoff owns the old scope. Pending network delivery does not block a new match.
    // Cleanup still requires settlement before issuing the exact release.
    void this.settle(identity).catch((error: unknown) => this.onDiagnostic('source_settle', error));
    if (this.source === source) {
      this.source = null;
      this.cleanupEvidence(identity, `source_retired_${cause}`, 0);
    }
  }

  private async reconcileIntent(deadline: number, force: boolean): Promise<void> {
    const state = await this.sourceState.snapshot();
    const intents = state.intents.filter((intent) => this.isCurrentInstallation(intent.scope));
    const pendingIds = new Set(intents.map((intent) => intent.id));
    for (const id of this.intentRetry.keys()) {
      if (!pendingIds.has(id)) this.intentRetry.delete(id);
    }
    if (!intents.length) return;
    const start = this.intentReconcileCursor % intents.length;
    const ordered = [...intents.slice(start), ...intents.slice(0, start)];
    // Rotate bounded work so an unavailable old match cannot starve later claims.
    let examined = 0;
    for (const intent of ordered) {
      if (examined >= 8 || Date.now() >= deadline) break;
      examined++;
      const retry = this.intentRetry.get(intent.id);
      if (!force && retry && Date.now() < retry.nextAt) continue;
      const attempts = Math.min((retry?.attempts ?? 0) + 1, 6);
      try {
        await this.reconcileIntentForState(
          intent,
          await this.sourceState.snapshot(),
          deadline,
          this.source,
          this.installation,
        );
      } catch (error) {
        this.onDiagnostic('source_status', error);
      } finally {
        this.intentRetry.set(intent.id, {
          attempts,
          nextAt: Date.now() + Math.min(300_000, 10_000 * 2 ** (attempts - 1)),
        });
      }
    }
    this.intentReconcileCursor = (start + examined) % intents.length;
  }

  private async reconcileIntentForState(
    intent: ClaimIntent,
    state: Awaited<ReturnType<RivalHubSourceState['snapshot']>>,
    deadline: number,
    claimedFrom: Source | null,
    installation: Installation | null,
  ): Promise<void> {
    if (!this.isCurrentInstallation(intent.scope) || Date.now() >= deadline) return;
    const signal = this.cleanupRequestSignal(deadline);
    let legacyScopeRecovery = false;
    if (!intent.claimRecoveryVersion) {
      const capability = await this.authorization.request('claim-recovery', { signal });
      if (!capability.ok && capability.status !== 404) return;
      if (capability.ok) {
        const support = (await readReliableBody(capability)) as
          { legacyScope?: unknown } | undefined;
        legacyScopeRecovery = support?.legacyScope === true;
      }
    }
    const response =
      intent.claimRecoveryVersion || legacyScopeRecovery
        ? await this.authorization.request('claim-recovery', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              matchId: intent.scope.matchId,
              producerInstanceId: intent.scope.producerInstanceId,
              liveSessionId: intent.scope.liveSessionId,
              ...(intent.claimRecoveryVersion ? { claimRequestId: intent.id } : { legacy: true }),
            }),
            signal,
          })
        : await this.authorization.request(sourceStatusRequest(intent.scope), { signal });
    if (!response.ok) return;
    const body: unknown = await readReliableBody(response);
    this.shutdownSignal?.throwIfAborted();
    const proof = claimRecoveryProof(body, intent, legacyScopeRecovery);
    if (!proof) return;
    if (proof.kind === 'clear') {
      await this.sourceState.clearIntent(intent.id);
      return;
    }
    const revision = proof.authorityRevision;
    if (
      !intent.claimRecoveryVersion &&
      intent.previousAuthorityRevision !== null &&
      revision <= intent.previousAuthorityRevision
    ) {
      if (revision !== intent.previousAuthorityRevision) return;
      if (intent.idempotentAuthorityRevision !== revision) {
        if (intent.idempotentAuthorityRevision !== undefined) return;
        // Historical requests without a receipt need evidence of the exact prior authority.
        const identity = { ...intent.scope, authorityRevision: revision };
        if (!state.records.some((record) => sameExactSource(record.identity, identity))) return;
        if (
          state.watermarks.some(
            (item) => sameScope(item, identity) && item.authorityRevision >= revision,
          )
        )
          return;
        const quarantined = await this.sourceState.getQuarantined(intent.scope);
        if (
          quarantined.some(
            (item) => item.kind === 'watermark' && item.identity.authorityRevision >= revision,
          )
        )
          return;
      }
    }
    if (proof.state === 'closed') {
      await this.sourceState.clearIntent(intent.id);
    } else {
      const identity = await this.sourceState.confirmClaim(intent.id, revision, 'release_pending');
      await this.handoffRecoveredClaim(identity, claimedFrom, installation, 'recovery');
    }
  }

  /** Freeze this exact source now; persist its handoff without waiting for delivery. */
  handoffForExit(matchId?: string): Promise<void> {
    return this.finishExitHandoffs(this.freezeExitSource('finish', matchId));
  }

  private async freezeExitSource(cause: 'finish' | 'shutdown', matchId?: string): Promise<void> {
    if (!this.sourceStateAvailable && (this.source || this.exitHandoffs.size))
      throw new Error('rivalhub_source_handoff_unavailable');
    this.requireSourceState();
    ++this.bindingGeneration;
    const source = this.source;
    let key: string | undefined;
    if (source && (matchId === undefined || source.matchId === matchId)) {
      this.stopSync(source.matchId);
      source.draining = true;
      source.paused = true;
      key = this.trackExitHandoff(this.sourceIdentity(source), cause);
    }
    if (matchId === undefined || key !== undefined)
      await this.persistExitHandoffs(matchId === undefined ? undefined : key);
    await this.updateCleanupSummary();
  }

  /** Retry only identities frozen by a prior exit, never the current source. */
  retryExitHandoffs(): Promise<void> {
    return this.finishExitHandoffs(this.retryLocalExitHandoffs());
  }

  private async retryLocalExitHandoffs(): Promise<void> {
    this.requireSourceState();
    await this.persistExitHandoffs();
    await this.updateCleanupSummary();
  }

  private finishExitHandoffs(handoff: Promise<void>): Promise<void> {
    void handoff
      .then(
        () => this.scheduleSourceCleanup(),
        () => undefined,
      )
      .catch((error: unknown) => this.onDiagnostic('source_cleanup', error));
    return handoff;
  }

  private trackExitHandoff(
    identity: ExactSource,
    cause: 'finish' | 'switch' | 'recovery' | 'shutdown',
  ): string {
    const key = exactKey(identity);
    if (!this.exitHandoffs.has(key)) this.exitHandoffs.set(key, { identity, cause });
    return key;
  }

  private persistExitHandoffs(onlyKey?: string): Promise<void> {
    return this.handoffCommits.run(() => {
      this.requireSourceState();
      return this.persistTrackedHandoffs(onlyKey);
    });
  }

  private async persistTrackedHandoffs(onlyKey?: string): Promise<void> {
    for (const [key, { identity, cause }] of this.exitHandoffs) {
      if (onlyKey !== undefined && key !== onlyKey) continue;
      const active = this.source;
      const current = active?.draining && sameExactSource(active, identity);
      if (current && this.captureLifecycle && !(await this.captureLifecycle.seal(identity))) {
        if (!this.captureLifecycle.coverage(identity).durableUnknown)
          throw new Error('rivalhub_source_capture_unconfirmed');
        this.cleanupEvidence(identity, 'source_capture_coverage_unknown', 0);
      }
      const state = await this.sourceState.snapshot();
      const record = state.records.find((item) => sameExactSource(item.identity, identity));
      if (record) await this.sourceState.handoff(identity, cause);
      else if (
        !state.watermarks.some(
          (item) =>
            sameScope(item, identity) && item.authorityRevision >= identity.authorityRevision,
        ) &&
        !(await this.sourceState.hasQuarantinedSource(identity))
      )
        throw new Error('数据源交接未确认。');
      this.exitHandoffs.delete(key);
      if (current && this.source === active) {
        this.source = null;
        this.cleanupEvidence(identity, `source_retired_${cause}`, 0);
      }
    }
  }

  private async cleanup(force: boolean, deadline = Date.now() + 7000): Promise<void> {
    this.shutdownSignal?.throwIfAborted();
    try {
      await this.persistExitHandoffs();
    } catch (error) {
      if (force) throw error;
      this.onDiagnostic('source_handoff', error);
    }
    await this.isolateRevokedSources();
    for (const identity of this.confirmedSourcesAwaitingPersistence.values()) {
      if (await this.persistConfirmedSource(identity)) await this.archiveConfirmedSource(identity);
    }
    try {
      // Keep part of the cleanup budget for already confirmed sources.
      await this.reconcileIntent(Math.min(deadline, Date.now() + 4000), force);
    } catch (error) {
      this.onDiagnostic('source_status', error);
    }
    this.shutdownSignal?.throwIfAborted();
    const state = await this.sourceState.snapshot();
    // A confirmed remote close needs only local work, even after disconnect or
    // switching installations. Never repeat release just to retry archiving.
    for (const record of state.records) {
      if (record.state !== 'archive_pending') continue;
      await this.archiveConfirmedSource(record.identity);
    }
    const pending = state.records.filter(
      (record) => record.state === 'release_pending' || canCheckBlockedSource(record, force),
    );
    const pendingKeys = new Set(pending.map(({ identity }) => exactKey(identity)));
    for (const key of this.blockedStatusRetryAt.keys())
      if (!pendingKeys.has(key)) this.blockedStatusRetryAt.delete(key);
    for (const key of this.cleanupAttempts.keys())
      if (!pendingKeys.has(key)) this.cleanupAttempts.delete(key);

    const start = !force && pending.length ? this.cleanupCursor % pending.length : 0;
    let examined = 0;
    while (!this.shutdownSignal?.aborted && Date.now() < deadline && examined < pending.length) {
      const record = pending[(start + examined++) % pending.length]!;
      const attemptKey = exactKey(record.identity);
      if (
        this.exitHandoffs.has(attemptKey) ||
        this.confirmedSourcesAwaitingPersistence.has(attemptKey)
      )
        continue;
      if (!this.isCurrentInstallation(record.identity)) {
        if (record.state === 'release_pending')
          await this.sourceState.failure(record.identity, 'installation_mismatch', null, true);
        continue;
      }
      if (record.state === 'blocked') {
        if ((this.blockedStatusRetryAt.get(attemptKey) ?? 0) <= Date.now())
          await this.checkBlockedSource(record.identity, record.attempts, deadline);
        continue;
      }
      if (record.retryAfterAt && Date.parse(record.retryAfterAt) > Date.now()) continue;
      const cycle = this.cleanupAttempts.get(attemptKey);
      if (!force && cycle && cycle.count >= 8 && Date.now() < cycle.nextCycleAt) continue;
      if (force || (cycle && cycle.count >= 8)) this.cleanupAttempts.delete(attemptKey);
      if (!force && record.nextAttemptAt && Date.parse(record.nextAttemptAt) > Date.now()) continue;
      const identity = record.identity;
      if (!(await this.settle(identity, Math.min(2500, deadline - Date.now())))) continue;
      if (this.shutdownSignal?.aborted || Date.now() >= deadline) break;
      const count = (this.cleanupAttempts.get(attemptKey)?.count ?? 0) + 1;
      this.cleanupAttempts.set(attemptKey, {
        count,
        // A later bounded round probes for network recovery; no identity is discarded.
        nextCycleAt: count >= 8 ? Date.now() + 600_000 : 0,
      });
      this.cleanupEvidence(identity, 'release_attempt', record.attempts + 1);
      let response: Response;
      try {
        response = await this.authorization.request('release', {
          method: 'POST',
          signal: this.cleanupRequestSignal(deadline),
          headers: {
            'content-type': 'application/json',
            'x-rivalhub-authority': String(identity.authorityRevision),
          },
          body: JSON.stringify({
            matchId: identity.matchId,
            producerInstanceId: identity.producerInstanceId,
            liveSessionId: identity.liveSessionId,
          }),
        });
      } catch (error) {
        if (this.shutdownSignal?.aborted) return;
        this.onDiagnostic('source_release', error);
        await this.sourceState.failure(
          identity,
          'network_failed',
          new Date(Date.now() + 5000).toISOString(),
          false,
        );
        this.cleanupEvidence(identity, 'release_pending', record.attempts + 1);
        continue;
      }
      const result = response.ok ? await readReliableBody(response) : undefined;
      if (this.shutdownSignal?.aborted) return;
      if (
        result &&
        typeof result === 'object' &&
        'released' in result &&
        result.released === true
      ) {
        if (this.source && sameExactSource(this.source, identity)) this.source = null;
        if (!(await this.persistConfirmedSource(identity))) continue;
        if (await this.archiveConfirmedSource(identity)) {
          this.cleanupAttempts.delete(attemptKey);
          this.cleanupEvidence(identity, 'release_confirmed', record.attempts + 1);
        }
        continue;
      }
      if (response.ok) {
        await this.sourceState.failure(
          identity,
          'invalid_response',
          new Date(Date.now() + 5000).toISOString(),
          false,
        );
        this.cleanupEvidence(identity, 'release_pending', record.attempts + 1);
        continue;
      }
      const retry = releaseRetry(
        response.status,
        record.attempts,
        response.headers.get('retry-after'),
        Date.now(),
      );
      await this.sourceState.failure(
        identity,
        `http_${response.status}`,
        retry.nextAttemptAt,
        retry.blocked,
        retry.retryAfterAt,
      );
      this.cleanupEvidence(
        identity,
        retry.blocked ? 'release_blocked' : 'release_pending',
        record.attempts + 1,
      );
    }
    if (!force) this.cleanupCursor = start + examined;
    if (!this.shutdownSignal?.aborted) await this.updateCleanupSummary();
  }

  private async checkBlockedSource(
    identity: ExactSource,
    attempts: number,
    deadline: number,
  ): Promise<void> {
    const key = exactKey(identity);
    this.blockedStatusRetryAt.set(key, Date.now() + 60_000);
    try {
      const response = await this.authorization.request(
        sourceStatusRequest(identity, identity.authorityRevision),
        { signal: this.cleanupRequestSignal(deadline) },
      );
      if (!response.ok) {
        const retryAt = serverRetryAt(response.headers.get('retry-after'), Date.now());
        if (retryAt) this.blockedStatusRetryAt.set(key, Math.max(Date.now() + 60_000, retryAt));
        return;
      }
      const body: unknown = await readReliableBody(response);
      this.shutdownSignal?.throwIfAborted();
      if (!confirmsClosedSource(body, identity)) return;
      if (await this.persistConfirmedSource(identity)) {
        this.cleanupEvidence(identity, 'source_status_closed', attempts);
        await this.archiveConfirmedSource(identity);
      }
    } catch (error) {
      if (!this.shutdownSignal?.aborted) this.onDiagnostic('source_status', error);
    }
  }

  private async isolateRevokedSources(preferred: readonly ExactSource[] = []): Promise<void> {
    if (!this.archiveSource) return;
    const now = Date.now();
    const cooling = [...this.revokedIsolationRetry.values()].filter((item) => item.retryAt > now);
    const excluded = [
      ...this.isolatedRevokedSources.values(),
      ...cooling.map((item) => item.identity),
    ];
    const candidates = new Map<string, ExactSource>();
    let backlog: readonly ExactSource[] = [];
    try {
      backlog = await this.sourceState.getRevokedSources(
        excluded,
        8,
        this.activeReliableSources?.() ?? [],
      );
    } catch (error) {
      this.onDiagnostic('source_revoked_scan', error);
    }
    for (const identity of [...preferred, ...backlog]) candidates.set(exactKey(identity), identity);
    for (const identity of candidates.values()) {
      const key = exactKey(identity);
      if (this.isolatedRevokedSources.has(key)) continue;
      if ((this.revokedIsolationRetry.get(key)?.retryAt ?? 0) > now) continue;
      try {
        await this.archiveSource(identity, 'revoked');
        this.isolatedRevokedSources.set(key, identity);
        this.revokedIsolationRetry.delete(key);
      } catch (error) {
        // Source-state evidence remains the durable retry request.
        this.revokedIsolationRetry.set(key, { identity, retryAt: now + 30_000 });
        this.onDiagnostic('source_revoked_isolation', error);
      }
    }
  }

  private async persistConfirmedSource(identity: ExactSource): Promise<boolean> {
    const key = exactKey(identity);
    this.confirmedSourcesAwaitingPersistence.set(key, identity);
    try {
      await this.sourceState.confirmReleased(identity);
      this.confirmedSourcesAwaitingPersistence.delete(key);
      return true;
    } catch (error) {
      this.onDiagnostic('source_release_confirmation', error);
      return false;
    }
  }

  private async archiveConfirmedSource(identity: ExactSource): Promise<boolean> {
    try {
      await this.archiveSource?.(identity);
      await this.sourceState.complete(identity);
      return true;
    } catch (error) {
      // Keep archive_pending durable and retry locally on the next cleanup.
      this.onDiagnostic('source_archive', error);
      return false;
    }
  }

  async disconnect(): Promise<void> {
    this.requireSourceState();
    return this.sourceCommands.run(() => this.disconnectLocked());
  }

  private async disconnectLocked(): Promise<void> {
    if (this.installation) {
      const installation = this.installation;
      try {
        await this.releaseLocked();
      } catch {
        // active source release is best-effort
      }
      const response = await this.authorization.request('disconnect', {
        method: 'POST',
      });
      const result = response.ok ? await readReliableBody(response) : undefined;
      if (
        !response.ok ||
        !result ||
        typeof result !== 'object' ||
        !('revoked' in result) ||
        result.revoked !== true
      ) {
        throw new Error('断开连接失败，请稍后重试。');
      }
      const revoked = await this.sourceState.confirmRevokedInstallation(installation);
      await this.isolateRevokedSources(revoked);
      await this.updateCleanupSummary();
    }
    await this.authorization.forget(() => {
      this.readClient.invalidate();
      this.source = null;
      this.activeDeviceName = null;
    });
  }

  async claim(
    snapshot: LiveSnapshotV1,
    contextRevision: string,
    takeover: boolean,
    isCurrent: () => boolean = () => true,
  ) {
    this.requireSourceState();
    const generation = this.bindingGeneration;
    return this.sourceCommands.run(() =>
      this.claimLocked(snapshot, contextRevision, takeover, generation, isCurrent),
    );
  }

  /** Normal first use only; recovery remains an explicit operator command. */
  async claimAutomatically(
    snapshot: LiveSnapshotV1,
    contextRevision: string,
    isCurrent: () => boolean,
  ): Promise<void> {
    const generation = this.bindingGeneration;
    await this.sourceCommands.run(async () => {
      const eligible = () =>
        this.sourceStateAvailable &&
        this.installation !== null &&
        generation === this.bindingGeneration &&
        isCurrent() &&
        this.source === null &&
        this.stoppedMatchId !== snapshot.matchId &&
        !(this.activeDeviceName && this.activeDeviceMatchId === snapshot.matchId);
      if (!eligible()) return;
      const sameMatch = (scope: SourceScope) =>
        this.isCurrentInstallation(scope) && scope.matchId === snapshot.matchId;
      const state = await this.sourceState.snapshot();
      // An unknown request must be reconciled by the existing cleanup owner first.
      // Old records for this match require explicit recovery, including another
      // producer/session. Other matches keep their independent durable cleanup.
      if (
        state.intents.some((intent) => sameMatch(intent.scope)) ||
        state.records.some((record) => sameMatch(record.identity)) ||
        state.revokedIntents.some((intent) => sameMatch(intent.scope)) ||
        [...this.exitHandoffs.values()].some(({ identity }) => sameMatch(identity)) ||
        !eligible()
      )
        return;
      const target = JSON.stringify([
        snapshot.matchId,
        executionKey(snapshot.cursor),
        contextRevision,
        snapshot.capability.lineupMismatchOnly === true,
        snapshot.players
          .filter((player) => player.lineupEvidence === 'current')
          .map((player) => player.sourcePlayerId)
          .sort(),
      ]);
      if (
        this.automaticClaimAttempts?.installation !== this.installation ||
        this.automaticClaimAttempts.target !== target
      )
        this.automaticClaimAttempts = { installation: this.installation!, target, count: 0 };
      // A definitive refusal can clear the durable intent without fixing its cause.
      // Bound unchanged automatic attempts; explicit commands remain available.
      if (this.automaticClaimAttempts.count >= 5) return;
      this.automaticClaimAttempts.count++;
      await this.claimLocked(snapshot, contextRevision, false, generation, isCurrent);
    });
  }

  /** Explicit recovery only. The existing source command queue owns cleanup and claim. */
  async resumeSync(snapshot: LiveSnapshotV1, contextRevision: string, isCurrent: () => boolean) {
    this.requireSourceState();
    const generation = this.bindingGeneration;
    return this.sourceCommands.run(async () => {
      if (!isCurrent() || generation !== this.bindingGeneration)
        throw new Error('比赛已变化，请重新确认网站同步。');
      await this.cleanup(true);
      if (!isCurrent() || generation !== this.bindingGeneration)
        throw new Error('比赛已变化，请重新确认网站同步。');
      const source = this.source;
      if (
        source &&
        !source.draining &&
        !source.paused &&
        source.matchId === snapshot.matchId &&
        source.producerInstanceId === snapshot.cursor.producerInstanceId &&
        source.liveSessionId === snapshot.cursor.liveSessionId &&
        this.stoppedMatchId !== snapshot.matchId
      ) {
        this.retryLive();
        return this.view();
      }
      // claimLocked checks persisted pending tails/authority and defaults to no takeover.
      return this.claimLocked(snapshot, contextRevision, false, generation, isCurrent);
    });
  }

  private async claimLocked(
    snapshot: LiveSnapshotV1,
    contextRevision: string,
    takeover: boolean,
    generation: number,
    isCurrent: () => boolean = () => true,
  ) {
    this.business('business_claim', snapshot, { contextRevision, reason: 'claim_started' });
    try {
      return await this.claimLockedOnce(snapshot, contextRevision, takeover, generation, isCurrent);
    } catch (error) {
      this.originalError('source_claim', error);
      this.business('business_claim', snapshot, {
        contextRevision,
        reason: requestFailureReason(error),
        causeCode: requestFailureCode(error),
      });
      throw error;
    }
  }

  private async claimLockedOnce(
    snapshot: LiveSnapshotV1,
    contextRevision: string,
    takeover: boolean,
    generation: number,
    isCurrent: () => boolean,
  ) {
    if (
      !this.installation ||
      snapshot.competitionId !== this.installation.competitionId ||
      !snapshot.cursor.liveSessionId
    )
      throw new Error('当前比赛尚未准备好连接。');
    const installation = this.installation;
    if (
      this.source &&
      (this.source.matchId !== snapshot.matchId ||
        this.source.producerInstanceId !== snapshot.cursor.producerInstanceId ||
        this.source.liveSessionId !== snapshot.cursor.liveSessionId)
    ) {
      await this.retireCurrent('switch');
      await this.cleanup(false);
    }
    if (generation !== this.bindingGeneration || !isCurrent())
      throw new Error('比赛已变化，请重新认领数据源。');
    const scope: SourceScope = {
      baseUrl: installation.baseUrl,
      competitionId: installation.competitionId,
      installationId: installation.installationId,
      matchId: snapshot.matchId,
      producerInstanceId: snapshot.cursor.producerInstanceId,
      liveSessionId: snapshot.cursor.liveSessionId,
    };
    const hasPendingHandoff = () =>
      [...this.exitHandoffs.values()].some(({ identity }) => sameScope(identity, scope));
    if (hasPendingHandoff()) throw new Error('原数据源正在完成本地交接。');
    const durableState = await this.sourceState.snapshot();
    if (hasPendingHandoff()) throw new Error('原数据源正在完成本地交接。');
    const matchingRecords = durableState.records.filter(({ identity }) =>
      sameScope(identity, scope),
    );
    if (matchingRecords.some((record) => record.state !== 'owned'))
      throw new Error('正在核对原数据源。');
    const priorRevisions = matchingRecords.map((record) => record.identity.authorityRevision);
    for (const item of durableState.watermarks)
      if (sameScope(item, scope)) priorRevisions.push(item.authorityRevision);
    const capability = await this.authorization.request('claim-recovery', {
      signal: AbortSignal.timeout(4000),
    });
    let claimRecoveryVersion: 1 | undefined;
    if (capability.ok) {
      const support = (await readReliableBody(capability)) as { version?: unknown } | undefined;
      if (support?.version !== 1) throw new Error('网站认领恢复协议无法确认。');
      claimRecoveryVersion = 1;
    } else if (capability.status !== 404) {
      throw new Error('暂时无法核对网站同步接口。');
    }
    if (generation !== this.bindingGeneration || !isCurrent())
      throw new Error('比赛已变化，请重新确认网站同步。');
    const intent = await this.sourceState.beginClaim(
      scope,
      priorRevisions.length ? Math.max(...priorRevisions) : null,
      this.captureLifecycle?.createReference(snapshot.cursor),
      claimRecoveryVersion,
    );
    this.business('business_claim', snapshot, {
      contextRevision,
      reason: 'claim_intent_persisted',
    });
    const claimedFrom = this.source;
    if (claimedFrom) claimedFrom.paused = true;
    await this.updateCleanupSummary();
    this.business('business_claim', snapshot, { contextRevision, reason: 'claim_attempt' });
    try {
      const lineupSteam64 = snapshot.players
        .filter(
          (player) => player.lineupEvidence === 'current' && /^\d{17}$/.test(player.sourcePlayerId),
        )
        .map((player) => player.sourcePlayerId);
      if (generation !== this.bindingGeneration || !isCurrent()) {
        await this.sourceState.clearIntent(intent.id);
        await this.updateCleanupSummary();
        throw new Error('比赛已变化，请重新确认网站同步。');
      }
      const response = await this.authorization.request('claim', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...(claimRecoveryVersion ? { claimRequestId: intent.id } : {}),
          matchId: snapshot.matchId,
          producerInstanceId: snapshot.cursor.producerInstanceId,
          liveSessionId: snapshot.cursor.liveSessionId,
          programSourceGeneration: snapshot.cursor.programSourceGeneration,
          mapEpoch: snapshot.cursor.mapEpoch,
          contextRevision,
          takeover,
          ...(snapshot.capability?.lineupMismatchOnly === true
            ? { allowLineupMismatch: true }
            : {}),
          lineupSteam64: lineupSteam64.length === 10 ? lineupSteam64 : [],
        }),
      });
      this.business('business_claim', snapshot, {
        contextRevision,
        httpStatus: response.status,
        reason: response.ok ? 'claim_response_received' : `http_${response.status}`,
      });
      if (!response.ok) {
        const refusal = await readReliableBody(response);
        if (!claimRecoveryVersion && definitiveClaimRejection(response, refusal)) {
          await this.sourceState.clearIntent(intent.id);
          await this.updateCleanupSummary();
        }
        this.eventTransport.setControlFailure(
          this.failureExecutionKey(snapshot),
          response.status === 401
            ? 'authorization_expired'
            : response.status === 403
              ? 'permission_denied'
              : response.status === 409
                ? 'context_conflict'
                : `http_${response.status}`,
        );
        throw new Error('当前比赛无法成为数据源，请检查同步状态后重试。');
      }
      const result = (await this.authorization.readJson(response)) as {
        claimed: boolean;
        authorityRevision: number;
        activeDeviceName?: string;
      };
      if (result.claimed === true) {
        if (!Number.isSafeInteger(result.authorityRevision) || result.authorityRevision <= 0)
          throw new Error('数据源授权响应无效，等待核对。');
        const identity = await this.sourceState.confirmClaim(intent.id, result.authorityRevision);
        if (claimedFrom && this.source === claimedFrom && !sameExactSource(claimedFrom, identity)) {
          claimedFrom.draining = true;
          claimedFrom.paused = true;
          this.sealCapture(this.sourceIdentity(claimedFrom));
        }
        if (generation !== this.bindingGeneration || !isCurrent()) {
          await this.handoffStaleClaim(identity, claimedFrom, installation);
          throw new Error('比赛已变化，原数据源待释放。');
        }
        if (this.captureLifecycle) {
          try {
            const reference = await this.confirmedCapture(identity);
            if (!reference) throw new Error('source_capture_legacy_coverage_unknown');
            await this.captureLifecycle.arm(identity, reference);
          } catch (error) {
            try {
              await this.handoffStaleClaim(identity, claimedFrom, installation);
            } catch (handoffError) {
              throw new AggregateError([error, handoffError], '数据采集区间启用未确认。', {
                cause: handoffError,
              });
            }
            throw error;
          }
          if (generation !== this.bindingGeneration || !isCurrent()) {
            await this.handoffStaleClaim(identity, claimedFrom, installation);
            throw new Error('比赛已变化，原数据源待释放。');
          }
        }
        try {
          // An accepted claim has no capture interval until arm completes.
          // Do not publish that transient absence as unknown historical coverage.
          await this.updateCleanupSummary();
        } catch (error) {
          try {
            await this.handoffStaleClaim(identity, claimedFrom, installation);
          } catch (handoffError) {
            throw new AggregateError([error, handoffError], '数据源交接未确认。', {
              cause: handoffError,
            });
          }
          throw error;
        }
        // Exit can invalidate the claim while the summary is read.
        if (generation !== this.bindingGeneration || !isCurrent()) {
          await this.handoffStaleClaim(identity, claimedFrom, installation);
          throw new Error('比赛已变化，原数据源待释放。');
        }
        if (this.captureLifecycle) {
          try {
            // No await between this actual capture-start cut and source publication.
            this.captureLifecycle.activate(identity);
          } catch (error) {
            try {
              await this.handoffStaleClaim(identity, claimedFrom, installation);
            } catch (handoffError) {
              throw new AggregateError([error, handoffError], '数据采集区间启用未确认。', {
                cause: handoffError,
              });
            }
            throw error;
          }
        }
        this.resumeSource?.(scope);
        this.stoppedMatchId = null;
        this.eventTransport.resetForNewClaim();
        this.claimRevision += 1;
        this.source = { ...identity };
        this.business('business_claim', snapshot, { contextRevision, reason: 'source_published' });
        this.activeDeviceName = null;
        this.activeDeviceMatchId = null;
      } else if (result.claimed === false) {
        await this.sourceState.clearIntent(intent.id);
        await this.updateCleanupSummary();
        if (generation !== this.bindingGeneration || !isCurrent())
          throw new Error('比赛已变化，请重新认领数据源。');
        if (this.source) this.source.paused = true;
        this.activeDeviceName = result.activeDeviceName ?? '另一台制播设备';
        this.activeDeviceMatchId = snapshot.matchId;
      } else throw new Error('数据源认领响应无效，等待核对。');
      this.business('business_claim', snapshot, {
        contextRevision,
        reason: result.claimed ? 'claim_accepted' : 'claim_rejected',
        acknowledgedAt: result.claimed ? new Date().toISOString() : null,
      });
      return this.view();
    } catch (error) {
      if (requestFailureReason(error) !== 'unknown') {
        this.eventTransport.setControlFailure(
          this.failureExecutionKey(snapshot),
          requestFailureReason(error),
        );
      }
      throw error;
    }
  }

  private freezePreviousClaimSource(
    identity: ExactSource,
    claimedFrom: Source | null,
    installation: Installation | null,
  ): void {
    if (
      claimedFrom &&
      installation &&
      this.source === claimedFrom &&
      this.installation === installation &&
      identity.baseUrl === installation.baseUrl &&
      identity.competitionId === installation.competitionId &&
      identity.installationId === installation.installationId &&
      claimedFrom.matchId === identity.matchId &&
      claimedFrom.producerInstanceId === identity.producerInstanceId &&
      claimedFrom.liveSessionId === identity.liveSessionId
    ) {
      // confirmClaim may also have retired the previous authority of this scope.
      claimedFrom.draining = true;
      claimedFrom.paused = true;
      this.sealCapture(this.sourceIdentity(claimedFrom));
    }
  }

  private async handoffStaleClaim(
    identity: ExactSource,
    claimedFrom: Source | null,
    installation: Installation,
  ): Promise<void> {
    await this.handoffRecoveredClaim(identity, claimedFrom, installation, 'switch');
    await this.updateCleanupSummary();
    this.scheduleSourceCleanup();
  }

  private handoffRecoveredClaim(
    identity: ExactSource,
    claimedFrom: Source | null,
    installation: Installation | null,
    cause: 'switch' | 'recovery',
  ): Promise<void> {
    // Fence the previous authority before awaiting the local commit queue.
    this.freezePreviousClaimSource(identity, claimedFrom, installation);
    return this.handoffCommits.run(async () => {
      this.requireSourceState();
      const key = this.trackExitHandoff(identity, cause);
      await this.restoreConfirmedCapture(identity);
      this.sealCapture(identity);
      await this.persistTrackedHandoffs(key);
    });
  }

  async release(): Promise<void> {
    this.requireSourceState();
    ++this.bindingGeneration;
    if (this.source) {
      this.source.draining = true;
      this.source.paused = true;
      this.sealCapture(this.sourceIdentity(this.source));
    }
    return this.sourceCommands.run(() => this.releaseLocked());
  }

  /** Retry a failed manual stop only while its original source is still retained. */
  async retryStoppedSource(matchId: string, isCurrent: () => boolean): Promise<void> {
    this.requireSourceState();
    const source = this.source;
    if (!source || !this.installation) throw new Error('rivalhub_stopped_source_changed');
    const identity = this.sourceIdentity(source);
    const key = exactKey(identity);
    const generation = this.bindingGeneration;
    await this.finishExitHandoffs(
      this.handoffCommits.run(async () => {
        this.requireSourceState();
        if (
          this.source !== source ||
          this.bindingGeneration !== generation ||
          this.stoppedMatchId !== matchId ||
          source.matchId !== matchId ||
          !source.draining ||
          !this.isCurrentInstallation(identity) ||
          !sameExactSource(source, identity) ||
          !this.exitHandoffs.has(key) ||
          !isCurrent()
        )
          throw new Error('rivalhub_stopped_source_changed');
        await this.persistTrackedHandoffs(key);
        await this.updateCleanupSummary();
      }),
    );
  }

  private async releaseLocked(): Promise<void> {
    this.requireSourceState();
    const deadline = Date.now() + 8000;
    await this.retireCurrent('finish');
    await this.cleanup(true, deadline);
    if (await this.hasOutstandingReleaseWork()) throw new Error('数据源释放待重试或核对。');
  }

  sendLive(snapshot: LiveSnapshotV1): Promise<void> {
    return this.eventTransport.sendLive(snapshot);
  }

  /** Deliver accepted work with its original durable authority, independent of the selected match. */
  sendRetainedReliable(
    event: ReliableEventV1,
    identity: ExactSource,
    current: LiveSnapshotV1 | null,
    signal?: AbortSignal,
    retainedLineup?: readonly string[],
  ): Promise<ReliableDeliveryResult> {
    return this.eventTransport.sendRetainedReliable(
      event,
      identity,
      current,
      signal,
      retainedLineup,
    );
  }

  sendReliable(
    event: ReliableEventV1,
    current: LiveSnapshotV1 | null,
    signal?: AbortSignal,
    retainedLineup?: readonly string[],
    retainedIdentity?: ExactSource,
  ): Promise<ReliableDeliveryResult> {
    return this.eventTransport.sendReliable(
      event,
      current,
      signal,
      retainedLineup,
      retainedIdentity,
    );
  }
}
