import { RepeatedDiagnostic } from '../support/repeated-diagnostic.js';
import { diagnosticValue } from '../support/session-journal.js';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import type { LiveSnapshotV1, ReliableEventV1 } from '@mizar/protocol/output';
import {
  RivalHubAuthorization,
  OFFICIAL_RIVALHUB_URL,
  type Installation,
} from './rivalhub-authorization.js';
import { RivalHubReadClient, type StatsTarget } from './rivalhub-read-client.js';
import {
  liveErrorEvidence,
  liveTimeout,
  requestFailureReason,
  requestFailureCode,
  rootNetworkCode,
  type LiveErrorEvidence,
} from './rivalhub-http-errors.js';
import {
  RELIABLE_SEND_TIMEOUT_MS,
  parseReliableRejection,
  type ReliableDeliveryResult,
} from '../output/reliable-delivery.js';
import { SerialCommitQueue } from './serial-commit.js';
import type { CaptureReference } from '../output/capture-interval.js';
import {
  RivalHubSourceState,
  type ExactSource,
  type ClaimIntent,
  type SourceScope,
} from './rivalhub-source-state.js';

export { OFFICIAL_RIVALHUB_URL } from './rivalhub-authorization.js';
export { statsTarget, type StatsTarget } from './rivalhub-read-client.js';

type LiveFailure = {
  stage: 'fetch' | 'read' | 'parse' | 'validate' | 'cancel';
  error: LiveErrorEvidence;
};

// Read only a small, time-limited classified rejection. Never retain raw body text.
async function readReliableBody(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) return undefined;
  const chunks: Uint8Array[] = [];
  let size = 0;
  const timeout = AbortSignal.timeout(1000);
  const deadline = new Promise<never>((_, reject) =>
    timeout.addEventListener('abort', () => reject(new Error('timeout')), { once: true }),
  );
  try {
    for (;;) {
      const part = await Promise.race([reader.read(), deadline]);
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 4096) return undefined;
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    return undefined;
  } finally {
    void reader.cancel().catch(() => undefined);
  }
}

export interface SourceCaptureLifecycle {
  createReference(cursor: ReliableEventV1['cursor']): CaptureReference;
  arm(identity: ExactSource, reference: CaptureReference): Promise<void>;
  activate(identity: ExactSource): void;
  restore(identity: ExactSource, reference: CaptureReference | undefined): Promise<void>;
  seal(identity: ExactSource): Promise<boolean>;
  coverage(identity: ExactSource): { state: 'armed' | 'sealed' | 'unknown' };
}

type Source = ExactSource & {
  acknowledgedExecution?: string;
  mapStartAttempt?: symbol;
  deliveryExecution?: string;
  paused?: boolean;
  draining?: boolean;
  drainReliable?: boolean;
};

/** Only explicit, structured receiver refusals prove that this claim did not commit. */
function definitiveClaimRejection(response: Response, body: unknown): boolean {
  if (!response.headers.get('content-type')?.toLowerCase().includes('application/json'))
    return false;
  if (!response.headers.get('cache-control')?.toLowerCase().includes('no-store')) return false;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const value = body as Record<string, unknown>;
  if (typeof value.error !== 'string' || !value.error || typeof value.code !== 'string')
    return false;
  return (
    (response.status === 400 && value.code === 'VALIDATION_FAILED') ||
    (response.status === 401 && value.code === 'UNAUTHORIZED') ||
    (response.status === 403 && value.code === 'FORBIDDEN') ||
    (response.status === 404 &&
      ['NOT_FOUND', 'MATCH_NOT_FOUND', 'SEASON_NOT_FOUND'].includes(value.code))
  );
}

function executionKey(cursor: LiveSnapshotV1['cursor']): string {
  return JSON.stringify([
    cursor.producerInstanceId,
    cursor.liveSessionId,
    cursor.programSourceGeneration,
    cursor.mapEpoch,
  ]);
}

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
  private readonly liveInFlight = new Map<Source, Set<Promise<void>>>();
  private readonly sourceSettlements = new Map<string, Promise<boolean>>();
  private readonly cleanupAttempts = new Map<string, { count: number; nextCycleAt: number }>();
  private readonly confirmedSourcesAwaitingPersistence = new Map<string, ExactSource>();
  private readonly exitHandoffs = new Map<
    string,
    { identity: ExactSource; cause: 'finish' | 'switch' | 'recovery' }
  >();
  private readonly sourceCommands = new SerialCommitQueue();
  private claimOperationsInFlight = 0;
  private automaticClaimAttempts: {
    installation: Installation;
    target: string;
    count: number;
  } | null = null;
  private readonly sourceState: RivalHubSourceState;
  private intentReconcileCursor = 0;
  private cleanupTimer: ReturnType<typeof setInterval> | undefined;
  private cleanupSummary = { pending: 0, blocked: 0, claimIntent: false, coverageUnknown: 0 };
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
  private controlFailure: string | null = null;
  private controlFailureScope: string | null = null;
  private failureScope(snapshot: { matchId: string; cursor: LiveSnapshotV1['cursor'] }): string {
    return JSON.stringify([snapshot.matchId, executionKey(snapshot.cursor), this.claimRevision]);
  }
  private nextLiveAt = 0;
  private liveFailures = 0;
  private liveFailureKind: 'transport' | 'receiver' | null = null;
  private syncWatch: {
    key: string;
    matchId: string;
    since: number;
    incidentId: string | null;
  } | null = null;
  private lastAcceptedAt = 0;
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
    const controlFailure =
      snapshot && this.controlFailureScope === this.failureScope(snapshot)
        ? this.controlFailure
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
    const current =
      snapshot &&
      this.source?.matchId === snapshot.matchId &&
      this.source.deliveryExecution === executionKey(snapshot.cursor) &&
      this.liveDelivery.cursor &&
      executionKey(this.liveDelivery.cursor) === executionKey(snapshot.cursor);
    const now = this.monotonicNow();
    const boundaryStatus = this.boundaryStatus?.() ?? null;
    if (
      !boundaryStatus &&
      current &&
      this.liveDelivery.status === 'accepted' &&
      now - this.lastAcceptedAt < 15_000
    ) {
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
            ? (this.liveDelivery.reason ?? 'reception_unconfirmed')
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
    this.controlFailureScope = this.failureScope(event);
    this.controlFailure = state;
  }

  retryLive(): void {
    this.nextLiveAt = 0;
    this.liveFailures = 0;
    this.liveFailureKind = null;
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
      this.sealCapture(this.exactSource(this.source));
    }
  }
  private liveDelivery: {
    cursor: LiveSnapshotV1['cursor'] | null;
    status: 'idle' | 'accepted' | 'dropped' | 'failing';
    reason: string | null;
    consecutiveUnaccepted: number;
    since: number | null;
    notified: boolean;
    failure?: LiveFailure;
  } = {
    cursor: null,
    status: 'idle',
    reason: null,
    consecutiveUnaccepted: 0,
    since: null,
    notified: false,
  };

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
    return this.source && this.installation ? this.exactSource(this.source) : undefined;
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
      () => this.releaseLocked(),
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
    return state.records.find(
      (record) => JSON.stringify(record.identity) === JSON.stringify(identity),
    )?.captureReference;
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
          : {
              status: this.liveDelivery.status,
              cursor: this.liveDelivery.cursor,
              reason: this.liveDelivery.reason,
              failure: this.liveDelivery.failure ?? null,
              consecutiveUnaccepted: this.liveDelivery.consecutiveUnaccepted,
              durationMs:
                this.liveDelivery.since === null
                  ? 0
                  : Math.max(0, this.monotonicNow() - this.liveDelivery.since),
            },
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
    this.cleanupTimer = setInterval(() => {
      void this.sourceCommands
        .run(() => this.cleanup(false))
        .catch((error: unknown) => this.onDiagnostic('source_cleanup', error));
    }, 10_000);
    this.cleanupTimer.unref();
    void this.sourceCommands
      .run(() => this.cleanup(false))
      .catch((error: unknown) => this.onDiagnostic('source_cleanup', error));
  }

  bindingChanged(matchId: string | null): void {
    const generation = ++this.bindingGeneration;
    if (this.source && this.source.matchId !== matchId) {
      this.source.draining = true;
      this.source.paused = true;
      this.sealCapture(this.exactSource(this.source));
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

  async shutdownSource(): Promise<void> {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.cleanupTimer = undefined;
    ++this.bindingGeneration;
    if (this.source) this.sealCapture(this.exactSource(this.source));
    try {
      await this.sourceCommands.run(async () => {
        const deadline = Date.now() + 8000;
        await this.retireCurrent('shutdown');
        await this.cleanup(true, deadline);
        if (await this.hasCurrentCleanup()) throw new Error('数据源释放待重试或核对。');
      });
    } finally {
      this.sourceStateAvailable = false;
      this.unavailableLive.clear();
      await this.sourceState.close();
    }
  }

  private async updateCleanupSummary(): Promise<void> {
    const state = await this.sourceState.snapshot();
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
  }

  private async hasCurrentCleanup(): Promise<boolean> {
    const state = await this.sourceState.snapshot();
    return (
      state.records.some(
        (item) =>
          item.state !== 'owned' &&
          (this.scopeMatches(item.identity) ||
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

  private scopeMatches(scope: SourceScope): boolean {
    return (
      this.installation !== null &&
      scope.baseUrl === this.installation.baseUrl &&
      scope.competitionId === this.installation.competitionId &&
      scope.installationId === this.installation.installationId
    );
  }

  private exactSource(source: Source): ExactSource {
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
    const key = JSON.stringify([
      identity.baseUrl,
      identity.competitionId,
      identity.installationId,
      identity.matchId,
      identity.producerInstanceId,
      identity.liveSessionId,
      identity.authorityRevision,
    ]);
    const drain = async () => {
      const requests = [...this.liveInFlight.entries()]
        .filter(([source]) => JSON.stringify(this.exactSource(source)) === JSON.stringify(identity))
        .flatMap(([, pending]) => [...pending]);
      // The output owner fences new events synchronously on entry. Only after
      // that fence exists may a paused source deliver its already queued tail.
      const disposition = this.settleSource!(identity).catch(() => false);
      const source = this.source;
      if (source?.draining && JSON.stringify(this.exactSource(source)) === JSON.stringify(identity))
        source.drainReliable = true;
      await Promise.allSettled(requests);
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
    const identity = this.exactSource(source);
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

  private async reconcileIntent(deadline: number): Promise<void> {
    const state = await this.sourceState.snapshot();
    const intents = state.intents.filter((intent) => this.scopeMatches(intent.scope));
    if (!intents.length) return;
    const start = this.intentReconcileCursor % intents.length;
    const ordered = [...intents.slice(start), ...intents.slice(0, start)];
    // Rotate bounded work so an unavailable old match cannot starve later claims.
    let examined = 0;
    for (const intent of ordered) {
      if (examined >= 8 || Date.now() >= deadline) break;
      examined++;
      this.claimOperationsInFlight++;
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
        this.claimOperationsInFlight--;
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
    if (!this.scopeMatches(intent.scope) || Date.now() >= deadline) return;
    const query = new URLSearchParams({
      matchId: intent.scope.matchId,
      producerInstanceId: intent.scope.producerInstanceId,
      liveSessionId: intent.scope.liveSessionId,
    });
    const response = await this.authorization.request(`source-status?${query}`, {
      signal: AbortSignal.timeout(Math.max(1, Math.min(4000, deadline - Date.now()))),
    });
    if (!response.ok) return;
    const result = (await readReliableBody(response)) as
      | {
          status?: unknown;
          source?: Record<string, unknown>;
        }
      | undefined;
    if (result?.status !== 'found' || !result.source) return;
    const found = result.source;
    if (
      found.installationId !== intent.scope.installationId ||
      found.competitionId !== intent.scope.competitionId ||
      found.matchId !== intent.scope.matchId ||
      found.producerInstanceId !== intent.scope.producerInstanceId ||
      found.liveSessionId !== intent.scope.liveSessionId ||
      !Number.isSafeInteger(found.authorityRevision) ||
      (found.authorityRevision as number) <= 0 ||
      (found.state !== 'open' && found.state !== 'closed')
    )
      return;
    const revision = found.authorityRevision as number;
    const quarantined = await this.sourceState.getQuarantined(intent.scope);
    // An equal revision is conclusive only when this claim started while that
    // exact authority was held. A watermark by itself proves no such thing.
    const legacyHeld = state.records.some(
      ({ identity }) =>
        identity.baseUrl === intent.scope.baseUrl &&
        identity.competitionId === intent.scope.competitionId &&
        identity.installationId === intent.scope.installationId &&
        identity.matchId === intent.scope.matchId &&
        identity.producerInstanceId === intent.scope.producerInstanceId &&
        identity.liveSessionId === intent.scope.liveSessionId &&
        identity.authorityRevision === revision &&
        !quarantined.some(
          (item) => item.kind === 'watermark' && item.identity.authorityRevision >= revision,
        ) &&
        !state.watermarks.some(
          (item) =>
            item.baseUrl === identity.baseUrl &&
            item.competitionId === identity.competitionId &&
            item.installationId === identity.installationId &&
            item.matchId === identity.matchId &&
            item.producerInstanceId === identity.producerInstanceId &&
            item.liveSessionId === identity.liveSessionId &&
            item.authorityRevision >= revision,
        ),
    );
    if (intent.previousAuthorityRevision !== null && revision <= intent.previousAuthorityRevision) {
      if (
        revision !== intent.previousAuthorityRevision ||
        (intent.idempotentAuthorityRevision !== revision &&
          !(intent.idempotentAuthorityRevision === undefined && legacyHeld))
      )
        return;
    }
    if (found.state === 'closed') {
      await this.sourceState.clearIntent(intent.id);
    } else {
      const identity = await this.sourceState.confirmClaim(
        intent.id,
        found.authorityRevision as number,
        'release_pending',
      );
      const key = this.trackExitHandoff(identity, 'recovery');
      await this.restoreConfirmedCapture(identity);
      this.sealCapture(identity);
      // A failed write must still leave the original source ready for a later drain.
      this.freezePreviousClaimSource(identity, claimedFrom, installation);
      await this.sourceState.handoff(identity, this.exitHandoffs.get(key)!.cause);
      this.exitHandoffs.delete(key);
    }
  }

  /** Freeze this exact source now; persist its handoff without waiting for delivery. */
  handoffForExit(): Promise<void> {
    if (!this.sourceStateAvailable)
      return Promise.reject(new Error('rivalhub_source_state_unavailable'));
    this.bindingGeneration++;
    const source = this.source;
    if (source) {
      this.stopSync(source.matchId);
      source.draining = true;
      source.paused = true;
      const identity = this.exactSource(source);
      this.trackExitHandoff(identity, 'finish');
      if (!this.settleSource) return Promise.reject(new Error('可靠事件范围尚未冻结。'));
      // settle() enters the output owner's fence synchronously; false remains pending.
      void this.settle(identity);
    }
    // The source-state owner serializes its own durable writes. Do not queue
    // this local handoff behind claim/release HTTP operations.
    const handoff = (async () => {
      await this.persistExitHandoffs();
      await this.updateCleanupSummary();
      if (
        this.cleanupSummary.claimIntent ||
        this.claimOperationsInFlight > 0 ||
        this.exitHandoffs.size > 0
      )
        throw new Error('数据源认领结果待核对。');
    })();
    void handoff
      .then(
        () => this.sourceCommands.run(() => this.cleanup(false)),
        () => undefined,
      )
      .catch((error: unknown) => this.onDiagnostic('source_cleanup', error));
    return handoff;
  }

  /** Retry only identities frozen by a prior exit, never the current source. */
  retryExitHandoffs(): Promise<void> {
    if (!this.sourceStateAvailable)
      return Promise.reject(new Error('rivalhub_source_state_unavailable'));
    if (this.exitHandoffs.size && !this.settleSource)
      return Promise.reject(new Error('可靠事件范围尚未冻结。'));
    const identities = [...this.exitHandoffs.values()].map(({ identity }) => identity);
    const handoff = (async () => {
      await this.persistExitHandoffs();
      for (const identity of identities) void this.settle(identity);
      await this.updateCleanupSummary();
      if (
        this.cleanupSummary.claimIntent ||
        this.claimOperationsInFlight > 0 ||
        this.exitHandoffs.size > 0
      )
        throw new Error('数据源认领结果待核对。');
    })();
    void handoff
      .then(
        () => this.sourceCommands.run(() => this.cleanup(false)),
        () => undefined,
      )
      .catch((error: unknown) => this.onDiagnostic('source_cleanup', error));
    return handoff;
  }

  private trackExitHandoff(identity: ExactSource, cause: 'finish' | 'switch' | 'recovery'): string {
    const key = JSON.stringify(identity);
    if (!this.exitHandoffs.has(key)) this.exitHandoffs.set(key, { identity, cause });
    return key;
  }

  private async persistExitHandoffs(): Promise<void> {
    for (const [key, { identity, cause }] of this.exitHandoffs) {
      const state = await this.sourceState.snapshot();
      const record = state.records.find((item) => JSON.stringify(item.identity) === key);
      if (record) await this.sourceState.handoff(identity, cause);
      else if (
        !state.watermarks.some(
          (item) =>
            item.baseUrl === identity.baseUrl &&
            item.competitionId === identity.competitionId &&
            item.installationId === identity.installationId &&
            item.matchId === identity.matchId &&
            item.producerInstanceId === identity.producerInstanceId &&
            item.liveSessionId === identity.liveSessionId &&
            item.authorityRevision >= identity.authorityRevision,
        ) &&
        !(await this.sourceState.hasQuarantinedSource(identity))
      )
        throw new Error('数据源交接未确认。');
      this.exitHandoffs.delete(key);
    }
  }

  private async cleanup(force: boolean, deadline = Date.now() + 7000): Promise<void> {
    await this.persistExitHandoffs();
    await this.isolateRevokedSources();
    for (const identity of this.confirmedSourcesAwaitingPersistence.values()) {
      if (await this.persistConfirmedSource(identity)) await this.archiveConfirmedSource(identity);
    }
    try {
      // Keep part of the cleanup budget for already confirmed sources.
      await this.reconcileIntent(Math.min(deadline, Date.now() + 4000));
    } catch (error) {
      this.onDiagnostic('source_status', error);
    }
    const state = await this.sourceState.snapshot();
    // A confirmed remote close needs only local work, even after disconnect or
    // switching installations. Never repeat release just to retry archiving.
    for (const record of state.records) {
      if (record.state !== 'archive_pending') continue;
      await this.archiveConfirmedSource(record.identity);
    }
    for (const record of state.records) {
      if (Date.now() >= deadline) break;
      if (record.state === 'owned' || record.state === 'archive_pending') continue;
      if (this.confirmedSourcesAwaitingPersistence.has(JSON.stringify(record.identity))) continue;
      if (!this.scopeMatches(record.identity)) {
        if (record.state === 'release_pending')
          await this.sourceState.failure(record.identity, 'installation_mismatch', null, true);
        continue;
      }
      if (record.state === 'blocked') {
        if (!force) continue;
        const identity = record.identity;
        const query = new URLSearchParams({
          matchId: identity.matchId,
          producerInstanceId: identity.producerInstanceId,
          liveSessionId: identity.liveSessionId,
          authorityRevision: String(identity.authorityRevision),
        });
        try {
          const response = await this.authorization.request(`source-status?${query}`, {
            signal: AbortSignal.timeout(Math.max(1, Math.min(4000, deadline - Date.now()))),
          });
          if (!response.ok) continue;
          const result = (await readReliableBody(response)) as
            | {
                status?: unknown;
                source?: Record<string, unknown>;
              }
            | undefined;
          const found = result?.source;
          if (
            result?.status === 'found' &&
            found?.state === 'closed' &&
            found.installationId === identity.installationId &&
            found.competitionId === identity.competitionId &&
            found.matchId === identity.matchId &&
            found.producerInstanceId === identity.producerInstanceId &&
            found.liveSessionId === identity.liveSessionId &&
            found.authorityRevision === identity.authorityRevision
          ) {
            if (await this.persistConfirmedSource(identity))
              await this.archiveConfirmedSource(identity);
          }
        } catch (error) {
          this.onDiagnostic('source_status', error);
        }
        continue;
      }
      const attemptKey = JSON.stringify(record.identity);
      if (record.retryAfterAt && Date.parse(record.retryAfterAt) > Date.now()) continue;
      const cycle = this.cleanupAttempts.get(attemptKey);
      if (!force && cycle && cycle.count >= 8 && Date.now() < cycle.nextCycleAt) continue;
      if (force || (cycle && cycle.count >= 8)) this.cleanupAttempts.delete(attemptKey);
      if (!force && record.nextAttemptAt && Date.parse(record.nextAttemptAt) > Date.now()) continue;
      const identity = record.identity;
      if (!(await this.settle(identity, Math.min(2500, deadline - Date.now())))) continue;
      if (Date.now() >= deadline) break;
      const count = (this.cleanupAttempts.get(attemptKey)?.count ?? 0) + 1;
      this.cleanupAttempts.set(attemptKey, {
        count,
        // A later bounded round probes for network recovery; no identity is discarded.
        nextCycleAt: count >= 8 ? Date.now() + 600_000 : 0,
      });
      try {
        this.cleanupEvidence(identity, 'release_attempt', record.attempts + 1);
        const response = await this.authorization.request('release', {
          method: 'POST',
          signal: AbortSignal.timeout(Math.max(1, Math.min(4000, deadline - Date.now()))),
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
        const result = response.ok ? await readReliableBody(response) : undefined;
        if (
          response.ok &&
          result &&
          typeof result === 'object' &&
          'released' in result &&
          result.released === true
        ) {
          if (
            this.source &&
            JSON.stringify(this.exactSource(this.source)) === JSON.stringify(identity)
          )
            this.source = null;
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
        const retryable =
          response.status === 408 || response.status === 429 || response.status >= 500;
        const delay = Math.floor(
          Math.max(1000, Math.min(60_000, 1000 * 2 ** Math.min(record.attempts, 6))) *
            (0.8 + Math.random() * 0.4),
        );
        const header = response.headers.get('retry-after');
        const retryAfter = header
          ? /^\d+$/.test(header.trim())
            ? Number(header) * 1000
            : Date.parse(header) - Date.now()
          : 0;
        const serverDelay = Number.isFinite(retryAfter)
          ? Math.max(0, Math.min(retryAfter, 253_402_300_799_000 - Date.now()))
          : 0;
        await this.sourceState.failure(
          identity,
          `http_${response.status}`,
          retryable ? new Date(Date.now() + Math.max(delay, serverDelay)).toISOString() : null,
          !retryable,
          retryable && serverDelay > 0 ? new Date(Date.now() + serverDelay).toISOString() : null,
        );
        this.cleanupEvidence(
          identity,
          retryable ? 'release_pending' : 'release_blocked',
          record.attempts + 1,
        );
      } catch (error) {
        this.onDiagnostic('source_release', error);
        await this.sourceState.failure(
          identity,
          'network_failed',
          new Date(Date.now() + 5000).toISOString(),
          false,
        );
        this.cleanupEvidence(identity, 'release_pending', record.attempts + 1);
      }
    }
    await this.updateCleanupSummary();
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
    for (const identity of [...preferred, ...backlog])
      candidates.set(JSON.stringify(identity), identity);
    for (const identity of candidates.values()) {
      const key = JSON.stringify(identity);
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
    const key = JSON.stringify(identity);
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
        this.scopeMatches(scope) && scope.matchId === snapshot.matchId;
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
    this.claimOperationsInFlight++;
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
    } finally {
      this.claimOperationsInFlight--;
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
      [...this.exitHandoffs.values()].some(
        ({ identity }) =>
          identity.baseUrl === scope.baseUrl &&
          identity.competitionId === scope.competitionId &&
          identity.installationId === scope.installationId &&
          identity.matchId === scope.matchId &&
          identity.producerInstanceId === scope.producerInstanceId &&
          identity.liveSessionId === scope.liveSessionId,
      );
    if (hasPendingHandoff()) throw new Error('原数据源交接未确认，请先重试交接。');
    const durableState = await this.sourceState.snapshot();
    if (hasPendingHandoff()) throw new Error('原数据源交接未确认，请先重试交接。');
    const matchingRecords = durableState.records.filter(
      (record) =>
        record.identity.baseUrl === scope.baseUrl &&
        record.identity.installationId === scope.installationId &&
        record.identity.competitionId === scope.competitionId &&
        record.identity.matchId === scope.matchId &&
        record.identity.producerInstanceId === scope.producerInstanceId &&
        record.identity.liveSessionId === scope.liveSessionId,
    );
    if (matchingRecords.some((record) => record.state !== 'owned'))
      throw new Error('原数据源尚待释放或核对，请处理后重新认领。');
    const priorRevisions = matchingRecords.map((record) => record.identity.authorityRevision);
    for (const item of durableState.watermarks)
      if (
        item.baseUrl === scope.baseUrl &&
        item.installationId === scope.installationId &&
        item.competitionId === scope.competitionId &&
        item.matchId === scope.matchId &&
        item.producerInstanceId === scope.producerInstanceId &&
        item.liveSessionId === scope.liveSessionId
      )
        priorRevisions.push(item.authorityRevision);
    if (generation !== this.bindingGeneration || !isCurrent())
      throw new Error('比赛已变化，请重新确认网站同步。');
    const intent = await this.sourceState.beginClaim(
      scope,
      priorRevisions.length ? Math.max(...priorRevisions) : null,
      this.captureLifecycle?.createReference(snapshot.cursor),
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
        if (definitiveClaimRejection(response, refusal)) {
          await this.sourceState.clearIntent(intent.id);
          await this.updateCleanupSummary();
        }
        this.controlFailureScope = this.failureScope(snapshot);
        this.controlFailure =
          response.status === 401
            ? 'authorization_expired'
            : response.status === 403
              ? 'permission_denied'
              : response.status === 409
                ? 'context_conflict'
                : `http_${response.status}`;
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
        if (
          claimedFrom &&
          this.source === claimedFrom &&
          JSON.stringify(this.exactSource(claimedFrom)) !== JSON.stringify(identity)
        ) {
          claimedFrom.draining = true;
          claimedFrom.paused = true;
          this.sealCapture(this.exactSource(claimedFrom));
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
        this.controlFailure = null;
        this.retryLive();
        this.liveDelivery = {
          cursor: null,
          status: 'idle',
          reason: null,
          consecutiveUnaccepted: 0,
          since: null,
          notified: false,
        };
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
        this.controlFailureScope = this.failureScope(snapshot);
        this.controlFailure = requestFailureReason(error);
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
      this.sealCapture(this.exactSource(claimedFrom));
    }
  }

  private async handoffStaleClaim(
    identity: ExactSource,
    claimedFrom: Source | null,
    installation: Installation,
  ): Promise<void> {
    // Keep the confirmed identity and its cause until the handoff is durable.
    const key = this.trackExitHandoff(identity, 'switch');
    this.freezePreviousClaimSource(identity, claimedFrom, installation);
    await this.restoreConfirmedCapture(identity);
    this.sealCapture(identity);
    await this.sourceState.handoff(identity, this.exitHandoffs.get(key)!.cause);
    // Publish the durable responsibility before returning the stale-claim error.
    // Keep the in-memory handoff too if refreshing this read-only summary fails.
    await this.updateCleanupSummary();
    this.exitHandoffs.delete(key);
    void this.sourceCommands
      .run(() => this.cleanup(false))
      .catch((error: unknown) => this.onDiagnostic('source_cleanup', error));
  }

  async release(): Promise<void> {
    this.requireSourceState();
    ++this.bindingGeneration;
    if (this.source) {
      this.source.draining = true;
      this.source.paused = true;
      this.sealCapture(this.exactSource(this.source));
    }
    return this.sourceCommands.run(() => this.releaseLocked());
  }

  /** Retry a failed manual stop only while its original source is still retained. */
  async retryStoppedSource(matchId: string, isCurrent: () => boolean): Promise<void> {
    this.requireSourceState();
    const source = this.source;
    const identity = source && this.installation ? this.exactSource(source) : undefined;
    const generation = this.bindingGeneration;
    const current = () =>
      Boolean(
        source &&
        identity &&
        this.source === source &&
        this.bindingGeneration === generation &&
        this.stoppedMatchId === matchId &&
        source.matchId === matchId &&
        source.draining === true &&
        this.scopeMatches(identity) &&
        JSON.stringify(this.exactSource(source)) === JSON.stringify(identity) &&
        isCurrent(),
      );
    if (!current()) throw new Error('rivalhub_stopped_source_changed');
    return this.sourceCommands.run(async () => {
      if (!current()) throw new Error('rivalhub_stopped_source_changed');
      await this.releaseLocked();
    });
  }

  private async releaseLocked(): Promise<void> {
    this.requireSourceState();
    const deadline = Date.now() + 8000;
    await this.retireCurrent('finish');
    await this.cleanup(true, deadline);
    if (await this.hasCurrentCleanup()) throw new Error('数据源释放待重试或核对。');
  }

  private async upload(
    operation: 'reliable',
    body: unknown,
    matchId: string,
    signal?: AbortSignal,
    isCurrent: () => boolean = () => true,
    retainedSource?: ExactSource,
  ): Promise<ReliableDeliveryResult> {
    const event = (body as { event: ReliableEventV1 }).event;
    const evidence = (fields: Record<string, unknown>) =>
      this.business('business_reliable', event, {
        idempotencyKey: event.idempotencyKey,
        eventKind: event.kind,
        originalObservedAt: event.observedAt,
        authorityRevision: source?.authorityRevision,
        ...fields,
      });
    const source =
      retainedSource &&
      (!this.source ||
        !this.scopeMatches(retainedSource) ||
        JSON.stringify(this.exactSource(this.source)) !== JSON.stringify(retainedSource))
        ? retainedSource
        : this.source;
    if (!source) {
      evidence({ reason: 'source_unavailable' });
      return 'retry';
    }
    if (source.matchId !== matchId) return 'retry';
    try {
      if (signal?.aborted || !isCurrent()) return 'retry';
      evidence({ reason: 'request_started', sentAt: new Date().toISOString() });
      const response = await this.authorization.request(operation, {
        ...(signal ? { signal } : {}),
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-rivalhub-authority': String(source.authorityRevision),
        },
        body: JSON.stringify(body),
      });
      const readBody =
        response.ok ||
        (response.status !== 408 && response.status !== 429 && response.status < 500);
      const responseData = readBody ? await readReliableBody(response) : undefined;
      const rejection = !response.ok ? parseReliableRejection(responseData) : undefined;
      const needsAttention =
        response.ok &&
        responseData !== null &&
        typeof responseData === 'object' &&
        !Array.isArray(responseData) &&
        (responseData as Record<string, unknown>).outcome === 'needs_attention';
      if (!readBody) await response.body?.cancel().catch(() => undefined);
      if (signal?.aborted || !isCurrent()) return 'retry';
      evidence({
        receiverOutcome: needsAttention ? 'needs_attention' : undefined,
        rejectionReason: rejection?.reason,
        requestId: rejection?.requestId,
        recovery: rejection?.recovery,
        reason: response.ok ? 'receiver_accepted' : `http_${response.status}`,
        httpStatus: response.status,
        acknowledgedAt: response.ok ? new Date().toISOString() : null,
      });
      if (response.ok)
        return needsAttention ? { status: 'accepted', outcome: 'needs_attention' } : 'accepted';
      if (
        event.kind === 'map_started' &&
        this.source === source &&
        this.source?.deliveryExecution === executionKey(event.cursor)
      ) {
        this.controlFailureScope = this.failureScope(event);
        this.controlFailure =
          rejection?.reason ??
          (response.status === 401
            ? 'authorization_expired'
            : response.status === 403
              ? 'permission_denied'
              : response.status === 409
                ? 'context_conflict'
                : `http_${response.status}`);
      }
      if (retainedSource && response.status === 401) return 'retry';
      if (response.status === 403) {
        if (this.source === source && this.source) this.source.paused = true;
        return retainedSource ? 'retry' : 'rejected';
      }
      return response.status === 408 || response.status === 429 || response.status >= 500
        ? 'retry'
        : (rejection ?? 'rejected');
    } catch (error) {
      if (
        isCurrent() &&
        !signal?.aborted &&
        event.kind === 'map_started' &&
        this.source === source &&
        this.source?.deliveryExecution === executionKey(event.cursor)
      ) {
        this.controlFailureScope = this.failureScope(event);
        this.controlFailure = requestFailureReason(error);
      }
      evidence({
        reason: signal?.aborted
          ? requestFailureReason(signal.reason) === 'timeout'
            ? 'timeout'
            : 'request_aborted'
          : requestFailureReason(error),
        causeCode: requestFailureCode(error),
      });
      return 'retry';
    }
  }

  private beginDeliveryExecution(source: Source, cursor: LiveSnapshotV1['cursor']): void {
    const execution = executionKey(cursor);
    if (source.deliveryExecution === execution) return;
    source.deliveryExecution = execution;
    this.retryLive();
    this.liveDelivery = {
      cursor,
      status: 'idle',
      reason: 'map_start_pending',
      consecutiveUnaccepted: 0,
      since: null,
      notified: false,
    };
  }

  async sendLive(snapshot: LiveSnapshotV1): Promise<void> {
    this.requireSourceState();
    const source = this.source;
    const pending = this.sendLiveOnce(snapshot);
    if (!source) return pending;
    const inFlight = this.liveInFlight.get(source) ?? new Set<Promise<void>>();
    inFlight.add(pending);
    this.liveInFlight.set(source, inFlight);
    try {
      await pending;
    } finally {
      inFlight.delete(pending);
      if (!inFlight.size) this.liveInFlight.delete(source);
    }
  }

  private async sendLiveOnce(snapshot: LiveSnapshotV1): Promise<void> {
    // Claiming a source does not establish the website's map/identity evidence.
    // Keep the disposable lane behind the reliable start acknowledgement, also
    // after re-claim, generation advance and map change. No old snapshot is queued.
    const source = this.source;
    if (this.stoppedMatchId === snapshot.matchId || source?.paused || source?.draining) return;
    if (
      !source ||
      source.matchId !== snapshot.matchId ||
      source.producerInstanceId !== snapshot.cursor.producerInstanceId ||
      source.liveSessionId !== snapshot.cursor.liveSessionId
    ) {
      this.business('business_live', snapshot, {
        reason: 'source_unavailable',
        sourceUnavailableReason: !source
          ? 'source_missing'
          : source.matchId !== snapshot.matchId
            ? 'match_mismatch'
            : source.producerInstanceId !== snapshot.cursor.producerInstanceId
              ? 'producer_mismatch'
              : 'session_mismatch',
      });
      throw new Error('rivalhub_live_unavailable');
    }
    this.beginDeliveryExecution(source, snapshot.cursor);
    const execution = executionKey(snapshot.cursor);
    if (source.acknowledgedExecution !== execution) {
      this.business('business_live', snapshot, { reason: 'map_start_pending' });
      throw new Error('rivalhub_map_start_pending');
    }
    if (this.monotonicNow() < this.nextLiveAt) return;
    let reason: string;
    let accepted = false;
    let dropped = false;
    let lostAuthority = false;
    let stage: LiveFailure['stage'] = 'fetch';
    let failure: LiveFailure | undefined;
    const signal = AbortSignal.timeout(4000);
    const sentAt = new Date().toISOString();
    let httpStatus: number | null = null;
    let serverDate: string | null = null;
    try {
      // LIVE is disposable: one bounded request, no retries and no response payload logging.
      const response = await this.fetchImpl(`${this.installation!.baseUrl}/api/mizar/live`, {
        method: 'POST',
        redirect: 'manual',
        signal,
        headers: {
          authorization: `Bearer ${this.installation!.credential}`,
          'content-type': 'application/json',
          'x-rivalhub-authority': String(source.authorityRevision),
        },
        body: JSON.stringify(snapshot),
      });
      httpStatus = response.status;
      const dateHeader = response.headers.get('date');
      if (dateHeader && Number.isFinite(Date.parse(dateHeader)))
        serverDate = new Date(dateHeader).toISOString();
      if (response.ok || response.status === 429) {
        // Bounded response consumption; remote details/URLs are never diagnostics.
        stage = 'read';
        const reader = (response.body as ReadableStream<Uint8Array> | null)?.getReader();
        let text = '';
        let bytes = 0;
        let readFailed = false;
        let readError: unknown;
        try {
          if (reader)
            for (;;) {
              const chunk = await reader.read();
              if (chunk.done) break;
              bytes += chunk.value.byteLength;
              if (bytes > 4096)
                throw Object.assign(new Error(''), {
                  name: 'LiveResponseLimitError',
                  code: 'LIVE_RESPONSE_TOO_LARGE',
                });
              text += new TextDecoder().decode(chunk.value);
            }
        } catch (error) {
          readFailed = true;
          readError = error;
        }
        try {
          await reader?.cancel();
        } catch (error) {
          if (!readFailed) {
            stage = 'cancel';
            readFailed = true;
            readError = error;
          }
        }
        reader?.releaseLock();
        if (readFailed) throw readError;
        stage = 'parse';
        const parsed: unknown = JSON.parse(text);
        stage = 'validate';
        if (
          typeof parsed !== 'object' ||
          parsed === null ||
          Array.isArray(parsed) ||
          (response.ok && !('accepted' in parsed && typeof parsed.accepted === 'boolean'))
        )
          throw Object.assign(new Error(''), {
            name: 'LiveResponseShapeError',
            code: 'LIVE_RESPONSE_INVALID',
          });
        const result = parsed as { accepted?: unknown; reason?: unknown };
        accepted = response.ok && result.accepted === true;
        const normal = ['frame_expired', 'contended', 'delivery_dropped'];
        dropped =
          (response.ok && result.accepted === false && normal.includes(String(result.reason))) ||
          (response.status === 429 && result.reason === 'capacity');
        reason = dropped
          ? String(result.reason)
          : result.reason === 'broadcast_unavailable'
            ? 'broadcast_unavailable'
            : response.ok
              ? 'unknown_rejection'
              : 'http_429';
      } else {
        reason = `http_${response.status}`;
        lostAuthority = response.status === 403;
        stage = 'cancel';
        await response.body?.cancel();
      }
    } catch (error) {
      this.originalError('live', error);
      const evidence = liveErrorEvidence(error);
      failure = { stage, error: evidence };
      reason =
        liveTimeout(evidence) || (signal.aborted && evidence.name === 'AbortError')
          ? 'timeout'
          : evidence.code === 'LIVE_RESPONSE_TOO_LARGE'
            ? 'response_too_large'
            : stage === 'parse' || stage === 'validate'
              ? 'invalid_response'
              : stage === 'fetch'
                ? 'network_failed'
                : stage === 'cancel'
                  ? 'response_cancel_failed'
                  : 'response_read_failed';
      // Keep only bounded evidence. A newer frame may recover; never resend this frame.
    }
    if (this.source !== source || source.deliveryExecution !== execution)
      throw new Error('rivalhub_live_unavailable');
    if (lostAuthority) {
      source.paused = true;
    }
    this.business('business_live', snapshot, {
      reason: accepted ? 'receiver_accepted' : reason,
      failureStage: failure?.stage,
      causeCode: failure?.error.cause?.code ?? failure?.error.code,
      sentAt,
      producedAt: snapshot.producedAt,
      cursor: snapshot.cursor,
      map: snapshot.map,
      capability: snapshot.capability,
      httpStatus,
      serverDate,
      receiptScope: 'ingestion acceptance only; website viewer validation/render is not observed',
      acknowledgedAt: accepted ? new Date().toISOString() : null,
    });
    const previous = this.liveDelivery;
    if (accepted) {
      this.controlFailure = null;
      this.lastAcceptedAt = this.monotonicNow();
      this.retryLive();
      if (previous.notified)
        this.onDiagnostic('live_recovered', new Error('RivalHub LIVE 投递已恢复。'));
      this.liveDelivery = {
        cursor: snapshot.cursor,
        status: 'accepted',
        reason: null,
        consecutiveUnaccepted: 0,
        since: null,
        notified: false,
      };
      return;
    }
    if (!dropped) {
      // Only pre-response, transient transport failures use the fast recovery lane.
      // Receiver failures keep the longer budget; a new frame is always sent.
      const code = failure ? rootNetworkCode(failure.error) : undefined;
      const transientNetwork =
        httpStatus === null &&
        (reason === 'timeout' ||
          (reason === 'network_failed' &&
            [
              'ECONNRESET',
              'ECONNREFUSED',
              'ENETUNREACH',
              'EHOSTUNREACH',
              'EAI_AGAIN',
              'ETIMEDOUT',
              'UND_ERR_SOCKET',
              'UND_ERR_CONNECT_TIMEOUT',
            ].includes(code ?? '')));
      const kind = transientNetwork ? 'transport' : 'receiver';
      this.liveFailures = this.liveFailureKind === kind ? this.liveFailures + 1 : 1;
      this.liveFailureKind = kind;
      this.nextLiveAt =
        this.monotonicNow() +
        Math.min(transientNetwork ? 2_000 : 8_000, 500 * 2 ** Math.min(this.liveFailures, 4));
      this.controlFailureScope = this.failureScope(snapshot);
      this.controlFailure =
        reason === 'http_401'
          ? 'authorization_expired'
          : reason === 'http_403'
            ? 'permission_denied'
            : reason === 'http_409'
              ? 'context_conflict'
              : reason;
    }
    this.liveDelivery = {
      cursor: snapshot.cursor,
      status: dropped && previous.status !== 'failing' ? 'dropped' : 'failing',
      reason,
      consecutiveUnaccepted: previous.consecutiveUnaccepted + 1,
      since: previous.since ?? this.monotonicNow(),
      notified: previous.notified,
      ...(failure ? { failure } : previous.failure ? { failure: previous.failure } : {}),
    };
    const duration = this.monotonicNow() - this.liveDelivery.since!;
    let newlyNotified = false;
    if (
      !this.liveDelivery.notified &&
      this.liveDelivery.consecutiveUnaccepted >= 5 &&
      duration >= 10_000
    ) {
      this.liveDelivery.status = 'failing';
      this.liveDelivery.notified = true;
      newlyNotified = true;
      this.onDiagnostic(
        'live',
        new Error(
          `RivalHub LIVE 持续未接收：${reason}；count=${this.liveDelivery.consecutiveUnaccepted}；durationMs=${Math.round(duration)}；stage=${this.liveDelivery.failure?.stage ?? 'acceptance'}`,
          { cause: this.liveDelivery.failure },
        ),
      );
    }
    if (lostAuthority || newlyNotified) throw new Error('rivalhub_live_unavailable');
  }

  /** Deliver accepted work with its original durable authority, independent of the selected match. */
  async sendRetainedReliable(
    event: ReliableEventV1,
    identity: ExactSource,
    current: LiveSnapshotV1 | null,
    signal?: AbortSignal,
    retainedLineup?: readonly string[],
  ): Promise<ReliableDeliveryResult> {
    this.requireSourceState();
    if (
      identity.matchId !== event.matchId ||
      identity.competitionId !== event.competitionId ||
      identity.producerInstanceId !== event.cursor.producerInstanceId ||
      identity.liveSessionId !== event.cursor.liveSessionId ||
      !this.scopeMatches(identity)
    )
      return 'retry';
    const installation = this.installation;
    const state = await this.sourceState.snapshot();
    const key = JSON.stringify(identity);
    const record = state.records.find((item) => JSON.stringify(item.identity) === key);
    if (
      !record ||
      !['owned', 'release_pending'].includes(record.state) ||
      record.installationRevoked ||
      record.quarantineUncertain ||
      this.confirmedSourcesAwaitingPersistence.has(key)
    )
      return 'retry';
    if (this.source && JSON.stringify(this.exactSource(this.source)) === key)
      return this.sendReliable(event, current, signal, retainedLineup, identity);
    const valid = () =>
      this.installation === installation &&
      this.scopeMatches(identity) &&
      !this.isolatedRevokedSources.has(key) &&
      !this.confirmedSourcesAwaitingPersistence.has(key);
    if (!valid()) return 'retry';
    return this.upload(
      'reliable',
      { event, lineupSteam64: retainedLineup ?? [] },
      event.matchId,
      signal,
      valid,
      identity,
    );
  }

  async sendReliable(
    event: ReliableEventV1,
    current: LiveSnapshotV1 | null,
    signal: AbortSignal = AbortSignal.timeout(RELIABLE_SEND_TIMEOUT_MS),
    retainedLineup?: readonly string[],
    retainedIdentity?: ExactSource,
  ): Promise<ReliableDeliveryResult> {
    this.requireSourceState();
    if (
      (this.stoppedMatchId === event.matchId || this.source?.paused) &&
      !this.source?.drainReliable
    )
      return 'retry';
    const source = this.source;
    // Durable recovery keeps the original producer evidence. A new claim cannot
    // authorize that old producer, even when the live session was restored.
    if (
      source &&
      (source.producerInstanceId !== event.cursor.producerInstanceId ||
        source.liveSessionId !== event.cursor.liveSessionId)
    ) {
      this.business('business_reliable', event, {
        idempotencyKey: event.idempotencyKey,
        reason: 'producer_mismatch',
      });
      return 'rejected';
    }
    const sameExecution =
      current?.matchId === event.matchId &&
      current.cursor.producerInstanceId === event.cursor.producerInstanceId &&
      current.cursor.liveSessionId === event.cursor.liveSessionId &&
      current.cursor.programSourceGeneration === event.cursor.programSourceGeneration &&
      current.cursor.mapEpoch === event.cursor.mapEpoch;
    const observed =
      retainedLineup ??
      (sameExecution
        ? current.players
            .filter(
              (player) =>
                player.lineupEvidence === 'current' && /^\d{17}$/.test(player.sourcePlayerId),
            )
            .map((player) => player.sourcePlayerId)
        : []);
    if (signal.aborted) return 'retry';
    const attempt = event.kind === 'map_started' ? Symbol('map_start') : undefined;
    if (source && attempt) {
      source.mapStartAttempt = attempt;
      if (sameExecution) this.beginDeliveryExecution(source, event.cursor);
    }
    const isCurrent = () =>
      (this.stoppedMatchId !== event.matchId || source?.drainReliable === true) &&
      this.source === source &&
      (attempt === undefined || source?.mapStartAttempt === attempt);
    const result = await this.upload(
      'reliable',
      { event, lineupSteam64: observed.length === 10 ? observed : [] },
      event.matchId,
      signal,
      isCurrent,
      retainedIdentity,
    );
    if (
      typeof result === 'object' &&
      result.status === 'accepted' &&
      sameExecution &&
      isCurrent() &&
      !signal.aborted
    ) {
      this.controlFailureScope = this.failureScope(event);
      this.controlFailure = 'reliable_needs_attention';
      this.liveDelivery = {
        ...this.liveDelivery,
        cursor: event.cursor,
        status: 'failing',
        reason: 'reliable_needs_attention',
        since: this.monotonicNow(),
      };
    }
    if (
      typeof result === 'object' &&
      result.status === 'rejected' &&
      sameExecution &&
      isCurrent() &&
      !signal.aborted &&
      (event.kind === 'source_generation_changed' || event.kind === 'map_epoch_changed')
    ) {
      this.controlFailureScope = this.failureScope(event);
      this.controlFailure = result.reason;
    }
    if (attempt && source && isCurrent() && !signal.aborted) {
      if (result === 'accepted' || (typeof result === 'object' && result.status === 'accepted')) {
        source.acknowledgedExecution = executionKey(event.cursor);
        this.business('business_reliable', event, {
          idempotencyKey: event.idempotencyKey,
          eventKind: event.kind,
          reason: 'map_start_acknowledged',
          acknowledgedAt: new Date().toISOString(),
        });
        if (source.deliveryExecution === executionKey(event.cursor)) {
          if (typeof result === 'object' && result.status === 'accepted')
            this.controlFailure = 'reliable_needs_attention';
          else if (this.controlFailure !== 'context_reconfirming') this.controlFailure = null;
        }
      } else if (
        (result === 'rejected' || (typeof result === 'object' && result.status === 'rejected')) &&
        sameExecution &&
        source.deliveryExecution === executionKey(event.cursor)
      )
        this.liveDelivery = {
          ...this.liveDelivery,
          status: 'failing',
          reason: 'map_start_rejected',
        };
    }
    return result;
  }
}
