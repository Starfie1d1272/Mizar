import { diagnosticValue } from '../support/session-journal.js';
import { randomUUID, createHash } from 'node:crypto';
import { SourceLoadError } from './source-error.js';
import { RivalHubLibrary } from './rivalhub-library.js';
import { readFile, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { LiveSnapshotV1, ReliableEventV1 } from '@mizar/protocol/output';
import type { MatchContext, ScheduleWindowV1 } from '@mizar/core/match-context';
import {
  toScheduleWindowV1,
  validateBroadcastScheduleWindow,
  validateBroadcastManifest,
} from '@mizar/rivalhub';
import { createOnlineManifestSource, readOnlineManifestResponse } from './http-source.js';
import { broadcastStatsSchema, type BroadcastStats } from '@mizar/protocol/broadcast-stats';
import { redactDiagnosticText, diagnosticNetworkCode } from '../updates/diagnostics.js';
import {
  RELIABLE_SEND_TIMEOUT_MS,
  parseReliableRejection,
  type ReliableDeliveryResult,
} from '../output/reliable-outbox.js';
import { SerialCommitQueue } from './serial-commit.js';
import { replaceDurableJson } from './durable-json.js';
import {
  RivalHubSourceState,
  type ExactSource,
  type SourceScope,
} from './rivalhub-source-state.js';

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

type Installation = {
  baseUrl: string;
  credential: string;
  installationId: string;
  competitionId: string;
  displayName: string;
  authorizedUser?: { userId: string; displayName: string } | undefined;
};

export type StatsTarget = {
  matchId: string;
  competitionId: string;
  entrantIds: readonly [string, string];
};

/** Bind the cache to the currently active match identity, independent of side order. */
export function statsTarget(
  context: Pick<MatchContext, 'matchId' | 'competition' | 'entrants'>,
): StatsTarget | null {
  const competitionId = context.competition?.competitionId;
  const entrantIds = [context.entrants.a.entryId, context.entrants.b.entryId] as const;
  if (!competitionId || !entrantIds[0] || !entrantIds[1] || entrantIds[0] === entrantIds[1])
    return null;
  return { matchId: context.matchId, competitionId, entrantIds };
}

const statsTargetKey = (target: StatsTarget) =>
  JSON.stringify([target.matchId, target.competitionId, ...[...target.entrantIds].sort()]);
type PendingPairing = {
  pairingId: string;
  pollToken: string;
  expiresAt: string;
};
export const OFFICIAL_RIVALHUB_URL = 'https://match.starfie1d.top';
const CONTROL_TIMEOUT_MS = 15_000;
const STATS_RETRY_MS = 30_000;

function statsRetryDelay(header: string | null): number {
  if (!header) return STATS_RETRY_MS;
  const value = header.trim();
  const delay = /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - Date.now();
  if (delay === Infinity) return Number.MAX_VALUE;
  return Number.isFinite(delay) && delay >= 0 ? Math.max(STATS_RETRY_MS, delay) : STATS_RETRY_MS;
}
type PairingStatus = 'idle' | 'pending' | 'expired' | 'authorized';
type Source = {
  matchId: string;
  authorityRevision: number;
  producerInstanceId: string;
  liveSessionId: string;
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

type LiveErrorEvidence = { name: string; code?: string | number; cause?: LiveErrorEvidence };
type LiveFailure = {
  stage: 'fetch' | 'read' | 'parse' | 'validate' | 'cancel';
  error: LiveErrorEvidence;
};

function liveErrorIdentifier(value: unknown): string | undefined {
  if (
    typeof value !== 'string' ||
    value.length > 64 ||
    !/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(value)
  )
    return undefined;
  return redactDiagnosticText(value) === value ? value : undefined;
}

// Do not retain messages/stacks: fetch and JSON errors can contain URLs, tokens or response bytes.
function liveErrorEvidence(error: unknown, depth = 0): LiveErrorEvidence {
  if (!(error instanceof Error)) return { name: 'UnknownError' };
  const name = liveErrorIdentifier(error.name) ?? 'UnknownError';
  const rawCode = 'code' in error ? error.code : undefined;
  const code =
    typeof rawCode === 'number' && Number.isSafeInteger(rawCode) && Math.abs(rawCode) <= 2147483647
      ? rawCode
      : liveErrorIdentifier(rawCode);
  return {
    name,
    ...(code === undefined ? {} : { code }),
    ...(depth < 2 && error.cause !== undefined
      ? { cause: liveErrorEvidence(error.cause, depth + 1) }
      : {}),
  };
}
function liveTimeout(error: LiveErrorEvidence): boolean {
  return (
    error.name === 'TimeoutError' ||
    [
      'ETIMEDOUT',
      'UND_ERR_CONNECT_TIMEOUT',
      'UND_ERR_HEADERS_TIMEOUT',
      'UND_ERR_BODY_TIMEOUT',
    ].includes(String(error.code ?? '')) ||
    (error.cause !== undefined && liveTimeout(error.cause))
  );
}

function requestFailureReason(error: unknown): string {
  if (error instanceof RivalHubResponseError)
    return error.code === 'RIVALHUB_INVALID_JSON' ? 'invalid_response' : 'response_read_failed';
  if (error instanceof Error && 'code' in error && error.code === 'RIVALHUB_TIMEOUT')
    return 'timeout';
  if (error instanceof Error && 'code' in error && error.code === 'RIVALHUB_NETWORK_FAILED')
    return 'network_failed';
  const evidence = liveErrorEvidence(error);
  if (liveTimeout(evidence)) return 'timeout';
  if (evidence.name === 'SyntaxError') return 'invalid_response';
  const network = (e: LiveErrorEvidence): boolean =>
    e.name === 'TypeError' || (e.cause !== undefined && network(e.cause));
  return network(evidence) ? 'network_failed' : 'unknown';
}
function rootNetworkCode(evidence: LiveErrorEvidence): string | undefined {
  return (
    (evidence.cause ? rootNetworkCode(evidence.cause) : undefined) ??
    diagnosticNetworkCode(evidence.code)
  );
}

function requestFailureCode(error: unknown): string | undefined {
  if (error instanceof Error && 'rootCauseCode' in error) {
    const code = diagnosticNetworkCode(error.rootCauseCode);
    if (code) return code;
  }
  return rootNetworkCode(liveErrorEvidence(error));
}

function executionKey(cursor: LiveSnapshotV1['cursor']): string {
  return JSON.stringify([
    cursor.producerInstanceId,
    cursor.liveSessionId,
    cursor.programSourceGeneration,
    cursor.mapEpoch,
  ]);
}

class RivalHubResponseError extends Error {
  readonly code: 'RIVALHUB_INVALID_JSON' | 'RIVALHUB_RESPONSE_READ_FAILED';
  constructor(kind: 'parse' | 'read') {
    super(
      kind === 'parse'
        ? 'RivalHub 返回的数据无法解析，请稍后重试。'
        : 'RivalHub 响应读取失败，请稍后重试。',
    );
    this.name = 'RivalHubResponseError';
    this.code = kind === 'parse' ? 'RIVALHUB_INVALID_JSON' : 'RIVALHUB_RESPONSE_READ_FAILED';
  }
}
function networkError(error: unknown): Error {
  if (error instanceof RivalHubResponseError) return error;
  const project = (raw: LiveErrorEvidence): LiveErrorEvidence => {
    const code = diagnosticNetworkCode(raw.code);
    return {
      name: ['Error', 'TypeError', 'AbortError', 'TimeoutError', 'SyntaxError'].includes(raw.name)
        ? raw.name
        : 'UnknownError',
      ...(code ? { code } : {}),
      ...(raw.cause ? { cause: project(raw.cause) } : {}),
    };
  };
  const evidence = project(liveErrorEvidence(error));
  const rootCauseCode = requestFailureCode(error);
  const timeout =
    liveTimeout(evidence) ||
    (rootCauseCode !== undefined && liveTimeout({ name: 'UnknownError', code: rootCauseCode }));
  const network = evidence.name === 'TypeError' || rootCauseCode !== undefined;
  return Object.assign(
    new Error(
      timeout
        ? '连接 RivalHub 超时，请检查网络后重试。'
        : network
          ? '连接 RivalHub 失败，请检查网络后重试。'
          : 'RivalHub 请求未完成，请稍后重试。',
      { cause: evidence },
    ),
    {
      name: 'RivalHubRequestError',
      ...(rootCauseCode ? { rootCauseCode } : {}),
      code: timeout
        ? 'RIVALHUB_TIMEOUT'
        : network
          ? 'RIVALHUB_NETWORK_FAILED'
          : 'RIVALHUB_REQUEST_FAILED',
    },
  );
}

function normalizeBaseUrl(value: string): string {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.hash ||
    url.search ||
    url.pathname !== '/' ||
    (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
  )
    throw new Error('请输入 RivalHub 的 HTTPS 网站地址。');
  return url.origin;
}

function authorizedUser(input: unknown): Installation['authorizedUser'] {
  if (!input || typeof input !== 'object') return undefined;
  const { userId, displayName } = input as Record<string, unknown>;
  if (
    typeof userId !== 'string' ||
    !userId.trim() ||
    userId.length > 128 ||
    typeof displayName !== 'string' ||
    !displayName.trim() ||
    displayName.length > 256
  )
    return undefined;
  return { userId: userId.trim(), displayName: displayName.trim() };
}

/** Companion-owned scoped installation. Never exposed to the browser. */
export class RivalHubConnection {
  private onDiagnostic: (operation: string, error: unknown) => void = () => {};
  setDiagnosticHandler(handler: (operation: string, error: unknown) => void): void {
    this.onDiagnostic = handler;
  }
  private businessHandler: ((stage: string, evidence: unknown) => void) | undefined;
  private originalError(operation: string, error: unknown): void {
    try {
      this.businessHandler?.('original_error', {
        operation,
        error: diagnosticValue(error, '', new Set(), [
          this.installation?.credential ?? '',
          this.authorizedPairing?.credential ?? '',
          this.pendingPairing?.pollToken ?? '',
        ]),
      });
    } catch {
      /* Diagnostic observers cannot change transport or authorization. */
    }
  }
  setBusinessEvidenceHandler(handler: (stage: string, evidence: unknown) => void): void {
    this.businessHandler = handler;
  }
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
      this.businessHandler?.(stage, {
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
      });
    } catch {
      /* Diagnostics cannot affect authorization or delivery. */
    }
  }
  private scheduleGeneration = 0;
  private scheduleWarning: string | null = null;
  private scheduleCache: {
    competitionId: string;
    value: ScheduleWindowV1;
    acquiredAt: number;
  } | null = null;
  getSchedule(): ScheduleWindowV1 | null {
    return this.installation &&
      this.scheduleCache?.competitionId === this.installation.competitionId &&
      this.monotonicNow() - this.scheduleCache.acquiredAt < 60_000
      ? this.scheduleCache.value
      : null;
  }
  private invalidateReadScope() {
    this.clearStats();
    this.statsAuthorizationBlocked = null;
    this.scheduleCache = null;
    this.scheduleWarning = null;
    this.browsingLibrary = null;
    this.manifestScope?.abort.abort();
    this.manifestScope = null;
  }
  private statsAuthorizationBlocked: Installation | null = null;
  private statsScope: {
    installation: Installation;
    targetKey: string;
    value: BroadcastStats | null;
    etag: string | null;
    pending: Promise<BroadcastStats | null> | null;
    generation: number;
    fetchedAt: string | null;
    retryAt: number;
    blocked: 'authorization' | null;
    abort: AbortController;
  } | null = null;

  /** Called at production entry and maintenance ticks, never by a local reader. */
  async stats(target: StatsTarget | null, refresh = false): Promise<BroadcastStats | null> {
    const installation = this.installation;
    if (
      !installation ||
      !target ||
      target.competitionId !== installation.competitionId ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(target.matchId) ||
      !target.entrantIds[0] ||
      !target.entrantIds[1] ||
      target.entrantIds[0] === target.entrantIds[1]
    ) {
      this.clearStats();
      return null;
    }
    const { matchId } = target;
    const entrantIds = [...target.entrantIds] as [string, string];
    const targetKey = statsTargetKey(target);
    if (this.statsScope?.installation !== installation || this.statsScope.targetKey !== targetKey) {
      this.clearStats();
      this.statsScope = {
        installation,
        targetKey,
        value: null,
        etag: null,
        pending: null,
        generation: 0,
        fetchedAt: null,
        retryAt: 0,
        blocked: this.statsAuthorizationBlocked === installation ? 'authorization' : null,
        abort: new AbortController(),
      };
    }
    const scope = this.statsScope;
    if (scope.pending) return scope.pending;
    if (scope.blocked === 'authorization') return null;
    if (!refresh && scope.value) return scope.value;
    if (this.monotonicNow() < scope.retryAt) return refresh ? null : scope.value;
    if (refresh) scope.blocked = null;
    const generation = ++scope.generation;
    const current = () =>
      this.statsScope === scope &&
      this.installation === installation &&
      scope.generation === generation &&
      !scope.abort.signal.aborted;
    const retry = (header: string | null = null) => {
      if (current()) scope.retryAt = this.monotonicNow() + statsRetryDelay(header);
    };
    const invalid = () => retry();
    const pending = (async () => {
      try {
        const response = await this.request(`stats?matchId=${encodeURIComponent(matchId)}`, {
          headers: scope.etag ? { 'if-none-match': scope.etag } : {},
          signal: AbortSignal.any([scope.abort.signal, AbortSignal.timeout(CONTROL_TIMEOUT_MS)]),
        });
        if (!current()) return null;
        if (response.status === 304 && scope.value) {
          scope.fetchedAt = new Date().toISOString();
          scope.retryAt = 0;
          scope.blocked = null;
          return scope.value;
        }
        if (response.status === 401 || response.status === 403) {
          scope.value = null;
          scope.etag = null;
          scope.fetchedAt = null;
          scope.blocked = 'authorization';
          this.statsAuthorizationBlocked = installation;
          return null;
        }
        if (!response.ok) {
          if ([408, 429, 500, 502, 503, 504].includes(response.status))
            retry(response.headers.get('retry-after'));
          else invalid();
          return null;
        }
        const parsed = broadcastStatsSchema.safeParse(await readOnlineManifestResponse(response));
        if (!current()) return null;
        if (
          !parsed.success ||
          parsed.data.matchId !== matchId ||
          parsed.data.competitionId !== installation.competitionId ||
          parsed.data.entrants.length !== 2 ||
          !entrantIds.every((id) => parsed.data.entrants.some((entry) => entry.entryId === id))
        ) {
          invalid();
          return null;
        }
        scope.value = parsed.data;
        scope.etag = response.headers.get('etag');
        scope.fetchedAt = new Date().toISOString();
        scope.retryAt = 0;
        scope.blocked = null;
        return scope.value;
      } catch (error) {
        if (!current()) return null;
        if (error instanceof SourceLoadError && error.code === 'invalid_response') invalid();
        else retry();
        return null;
      }
    })().finally(() => {
      if (scope.pending === pending) scope.pending = null;
    });
    scope.pending = pending;
    return pending;
  }
  clearStats(): void {
    this.statsScope?.abort.abort();
    this.statsScope = null;
  }
  statsFetchedAt(target: StatsTarget | null): string | null {
    return this.statsScope?.installation === this.installation &&
      target &&
      this.statsScope.targetKey === statsTargetKey(target)
      ? this.statsScope.fetchedAt
      : null;
  }
  /** Read the current snapshot without waiting for or starting a website request. */
  getStatsSnapshot(target: StatsTarget | null): BroadcastStats | null {
    const scope = this.statsScope;
    return scope &&
      target &&
      scope.installation === this.installation &&
      scope.targetKey === statsTargetKey(target)
      ? scope.value
      : null;
  }
  async getStats(target: StatsTarget | null): Promise<BroadcastStats | null> {
    const scope = this.statsScope;
    if (
      !scope ||
      !target ||
      scope.installation !== this.installation ||
      scope.targetKey !== statsTargetKey(target)
    )
      return null;
    return scope.value ?? (scope.pending ? await scope.pending : null);
  }
  private installation: Installation | null = null;
  private pendingPairing: PendingPairing | null = null;
  private authorizedPairing: Installation | null = null;
  private pairingPoll: Promise<PairingStatus> | null = null;
  private source: Source | null = null;
  private readonly liveInFlight = new Map<Source, Set<Promise<void>>>();
  private readonly sourceSettlements = new Map<string, Promise<boolean>>();
  private readonly cleanupAttempts = new Map<string, { count: number; nextCycleAt: number }>();
  private readonly exitHandoffs = new Map<string, ExactSource>();
  private readonly sourceCommands = new SerialCommitQueue();
  private readonly sourceState: RivalHubSourceState;
  private cleanupTimer: ReturnType<typeof setInterval> | undefined;
  private cleanupSummary = { pending: 0, blocked: 0, claimIntent: false };
  private settleSource: ((scope: SourceScope) => Promise<boolean>) | undefined;
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
    // Only a current, bound formal execution can start a watch. Warmup and
    // unbound practice/demo inputs never establish an expected website stream.
    if (snapshot && snapshot.map.phase !== 'live') {
      this.syncWatch = null;
      return result('inactive');
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
    if (!watch) return result('inactive');
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
      (snapshot && this.controlFailureScope === this.failureScope(snapshot)
        ? this.controlFailure
        : null) ??
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
    this.stoppedMatchId = matchId;
    this.syncWatch = null;
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
          this.source.matchId,
          this.source.authorityRevision,
          this.source.producerInstanceId,
          this.source.liveSessionId,
          this.claimRevision,
        ]);
  }

  constructor(
    private readonly path: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly baseUrl = OFFICIAL_RIVALHUB_URL,
    private readonly monotonicNow = () => performance.now(),
  ) {
    this.sourceState = new RivalHubSourceState(join(dirname(path), 'rivalhub-source-state.json'));
  }

  async load(): Promise<void> {
    await this.sourceState.load();
    await this.sourceState.recover();
    await this.updateCleanupSummary();
    let stage = 'connection_read';
    try {
      const raw = await readFile(this.path, 'utf8');
      stage = 'connection_parse';
      let parsed: Installation;
      try {
        parsed = JSON.parse(raw) as Installation;
      } catch (error) {
        // SyntaxError can quote the credential file before its key is known.
        if (error instanceof SyntaxError) {
          error.message = error.message.replace(/"[\s\S]*"/g, '"[redacted credential excerpt]"');
          if (error.stack)
            error.stack = error.stack.replace(/"[^\n]*"/g, '"[redacted credential excerpt]"');
        }
        throw error;
      }
      stage = 'connection_validate';
      if (
        !parsed ||
        typeof parsed.credential !== 'string' ||
        typeof parsed.installationId !== 'string' ||
        typeof parsed.competitionId !== 'string'
      )
        throw new Error('RivalHub connection setting has an invalid format');
      let baseUrl: string;
      try {
        baseUrl = normalizeBaseUrl(parsed.baseUrl);
      } catch {
        // A malformed URL exception may echo credential-bearing input.
        throw new Error('RivalHub connection setting has an invalid base URL');
      }
      const blocked = this.statsAuthorizationBlocked;
      const sameBlockedInstallation =
        blocked !== null &&
        blocked.baseUrl === baseUrl &&
        blocked.installationId === parsed.installationId &&
        blocked.competitionId === parsed.competitionId &&
        blocked.credential === parsed.credential;
      this.invalidateReadScope();
      this.installation = {
        ...parsed,
        baseUrl,
        authorizedUser: authorizedUser(parsed.authorizedUser),
      };
      if (sameBlockedInstallation) this.statsAuthorizationBlocked = this.installation;
    } catch (error) {
      if (stage === 'connection_read' && (error as NodeJS.ErrnoException)?.code === 'ENOENT')
        return;
      this.onDiagnostic(stage, error);
      this.originalError(stage, error);
    }
  }

  view() {
    return {
      paired: this.installation !== null,
      competitionId: this.installation?.competitionId ?? null,
      displayName: this.installation?.displayName ?? null,
      authorizedUser: this.installation?.authorizedUser ?? null,
      scheduleWarning: this.scheduleWarning,
      activeSourceMatchId: this.source?.matchId ?? null,
      activeDeviceName: this.activeDeviceName,
      activeDeviceMatchId: this.activeDeviceMatchId,
      pairing: this.pendingPairing === null ? 'idle' : 'pending',
      stoppedMatchId: this.stoppedMatchId,
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
  ): void {
    this.settleSource = settle;
    this.resumeSource = resume;
  }

  startSourceCleanup(): void {
    if (this.cleanupTimer) return;
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
    if (this.source && this.source.matchId !== matchId) this.source.draining = true;
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

  async shutdownSource(): Promise<void> {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.cleanupTimer = undefined;
    return this.sourceCommands.run(async () => {
      const deadline = Date.now() + 8000;
      await this.retireCurrent('shutdown');
      await this.cleanup(true, deadline);
      if (
        this.cleanupSummary.pending ||
        this.cleanupSummary.blocked ||
        this.cleanupSummary.claimIntent
      )
        throw new Error('数据源释放待重试或核对。');
    });
  }

  private async updateCleanupSummary(): Promise<void> {
    const state = await this.sourceState.snapshot();
    this.cleanupSummary = {
      pending: state.records.filter((item) => item.state === 'release_pending').length,
      blocked: state.records.filter((item) => item.state === 'blocked').length,
      claimIntent: state.intent !== null,
    };
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
    if (!this.installation) throw new Error('请先连接 RivalHub。');
    return {
      baseUrl: this.installation.baseUrl,
      competitionId: this.installation.competitionId,
      installationId: this.installation.installationId,
      matchId: source.matchId,
      producerInstanceId: source.producerInstanceId,
      liveSessionId: source.liveSessionId,
      authorityRevision: source.authorityRevision,
    };
  }

  private async settle(identity: ExactSource, budgetMs = 2500): Promise<boolean> {
    if (!this.settleSource) return false;
    const key = JSON.stringify([
      identity.matchId,
      identity.producerInstanceId,
      identity.liveSessionId,
      identity.authorityRevision,
    ]);
    const drain = async () => {
      const requests = [...this.liveInFlight.entries()]
        .filter(
          ([source]) =>
            source.matchId === identity.matchId &&
            source.producerInstanceId === identity.producerInstanceId &&
            source.liveSessionId === identity.liveSessionId &&
            source.authorityRevision === identity.authorityRevision,
        )
        .flatMap(([, pending]) => [...pending]);
      // The output owner fences new events synchronously on entry. Only after
      // that fence exists may a paused source deliver its already queued tail.
      const disposition = this.settleSource!(identity).catch(() => false);
      const source = this.source;
      if (
        source?.draining &&
        source.matchId === identity.matchId &&
        source.producerInstanceId === identity.producerInstanceId &&
        source.liveSessionId === identity.liveSessionId &&
        source.authorityRevision === identity.authorityRevision
      )
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
    await this.sourceState.handoff(identity, cause);
    await this.updateCleanupSummary();
    if (!(await this.settle(identity))) throw new Error('可靠事件仍待确认，数据源释放待重试。');
    if (this.source === source) this.source = null;
  }

  private async reconcileIntent(deadline: number): Promise<void> {
    const state = await this.sourceState.snapshot();
    const intent = state.intent;
    if (!intent || !this.scopeMatches(intent.scope) || Date.now() >= deadline) return;
    const query = new URLSearchParams({
      matchId: intent.scope.matchId,
      producerInstanceId: intent.scope.producerInstanceId,
      liveSessionId: intent.scope.liveSessionId,
    });
    const response = await this.request(`source-status?${query}`, {
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
      );
      await this.sourceState.handoff(identity, 'recovery');
      // Reconciliation can also run in the original process after a lost
      // idempotent response. Fence its live source so the output owner can
      // finish its existing reliable tail before cleanup releases it.
      if (this.source && JSON.stringify(this.exactSource(this.source)) === JSON.stringify(identity))
        this.source.draining = true;
    }
  }

  /** Freeze this exact source now; persist its handoff without waiting for delivery. */
  handoffForExit(): Promise<void> {
    this.bindingGeneration++;
    const source = this.source;
    if (source) {
      this.stopSync(source.matchId);
      source.draining = true;
      source.paused = true;
      const identity = this.exactSource(source);
      // settle() enters the output owner's fence synchronously; false remains pending.
      void this.settle(identity);
      this.exitHandoffs.set(JSON.stringify(identity), identity);
    }
    const handoff = this.sourceCommands.run(async () => {
      await this.persistExitHandoffs();
      await this.updateCleanupSummary();
      if (this.cleanupSummary.claimIntent) throw new Error('数据源认领结果待核对。');
    });
    void handoff
      .then(
        () => this.sourceCommands.run(() => this.cleanup(false)),
        () => undefined,
      )
      .catch((error: unknown) => this.onDiagnostic('source_cleanup', error));
    return handoff;
  }

  private async persistExitHandoffs(): Promise<void> {
    for (const [key, identity] of this.exitHandoffs) {
      const state = await this.sourceState.snapshot();
      const record = state.records.find((item) => JSON.stringify(item.identity) === key);
      if (record) await this.sourceState.handoff(identity, 'finish');
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
        )
      )
        throw new Error('数据源交接未确认。');
      this.exitHandoffs.delete(key);
    }
  }

  private async cleanup(force: boolean, deadline = Date.now() + 7000): Promise<void> {
    await this.persistExitHandoffs();
    try {
      await this.reconcileIntent(deadline);
    } catch (error) {
      this.onDiagnostic('source_status', error);
    }
    const state = await this.sourceState.snapshot();
    for (const record of state.records) {
      if (Date.now() >= deadline) break;
      if (record.state === 'owned') continue;
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
          const response = await this.request(`source-status?${query}`, {
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
          )
            await this.sourceState.complete(identity);
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
        const response = await this.request('release', {
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
          await this.sourceState.complete(identity);
          this.cleanupAttempts.delete(attemptKey);
          this.cleanupEvidence(identity, 'release_confirmed', record.attempts + 1);
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

  async disconnect(): Promise<void> {
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
      const response = await this.request('disconnect', {
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
      await this.sourceState.completeRevokedInstallation(installation);
      await this.updateCleanupSummary();
    }
    await unlink(this.path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
    this.installation = null;
    this.invalidateReadScope();
    this.scheduleCache = null;
    this.source = null;
    this.activeDeviceName = null;
    this.pendingPairing = null;
    this.authorizedPairing = null;
  }

  private async persist(installation: Installation): Promise<void> {
    await replaceDurableJson(this.path, installation);
  }

  private async request(operation: string, init: RequestInit = {}): Promise<Response> {
    if (!this.installation) throw new Error('请先连接 RivalHub。');
    try {
      const response = await this.fetchImpl(`${this.installation.baseUrl}/api/mizar/${operation}`, {
        ...init,
        redirect: 'manual',
        headers: { authorization: `Bearer ${this.installation.credential}`, ...init.headers },
        signal:
          init.signal ?? AbortSignal.timeout(operation === 'live' ? 4000 : CONTROL_TIMEOUT_MS),
      });
      if (!response.ok && response.status !== 304) {
        if (operation !== 'reliable' && operation !== 'claim') await response.body?.cancel();
        this.onDiagnostic(operation, new Error(`RivalHub HTTP ${response.status}`));
      }
      return response;
    } catch (error) {
      this.originalError(operation, error);
      const safe = networkError(error);
      this.onDiagnostic(operation, safe);
      throw safe;
    }
  }

  private async readJson(response: Response): Promise<unknown> {
    try {
      return await response.json();
    } catch (error) {
      // Keep the credential-redacted original in private local evidence; the browser
      // and transport classifier retain their existing safe public projection.
      this.originalError('response_json', error);
      throw new RivalHubResponseError(error instanceof SyntaxError ? 'parse' : 'read');
    }
  }

  async startPairing(): Promise<{ authorizeUrl: string; expiresAt: string }> {
    return this.sourceCommands.run(() => this.startPairingLocked());
  }

  private async startPairingLocked(): Promise<{ authorizeUrl: string; expiresAt: string }> {
    const baseUrl = normalizeBaseUrl(this.baseUrl);
    const response = await this.fetchImpl(`${baseUrl}/api/mizar/pairing/start`, {
      method: 'POST',
      redirect: 'manual',
      signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS),
    }).catch((error: unknown) => {
      this.originalError('pairing', error);
      throw networkError(error);
    });
    if (!response.ok) throw new Error('无法发起授权，请稍后重试。');
    const value = (await this.readJson(response)) as {
      pairingId?: unknown;
      pollToken?: unknown;
      authorizeUrl?: unknown;
      expiresAt?: unknown;
    };
    if (
      typeof value.pairingId !== 'string' ||
      !/^[a-f0-9-]{36}$/i.test(value.pairingId) ||
      typeof value.pollToken !== 'string' ||
      !/^[a-f0-9]{64}$/i.test(value.pollToken) ||
      typeof value.authorizeUrl !== 'string' ||
      typeof value.expiresAt !== 'string' ||
      !Number.isFinite(Date.parse(value.expiresAt)) ||
      Date.parse(value.expiresAt) <= Date.now()
    )
      throw new Error('授权请求格式无效。');
    const authorizeUrl = new URL(value.authorizeUrl);
    if (
      authorizeUrl.origin !== baseUrl ||
      authorizeUrl.username ||
      authorizeUrl.password ||
      authorizeUrl.hash ||
      authorizeUrl.pathname !== '/integrations/mizar/connect' ||
      authorizeUrl.searchParams.get('pairingId') !== value.pairingId
    )
      throw new Error('授权页面地址无效。');
    this.pendingPairing = {
      pairingId: value.pairingId,
      pollToken: value.pollToken,
      expiresAt: value.expiresAt,
    };
    this.authorizedPairing = null;
    return { authorizeUrl: authorizeUrl.toString(), expiresAt: value.expiresAt };
  }

  pollPairing(): Promise<PairingStatus> {
    if (!this.pairingPoll)
      this.pairingPoll = this.sourceCommands
        .run(() => this.pollPairingOnce())
        .finally(() => {
          this.pairingPoll = null;
        });
    return this.pairingPoll;
  }

  private async pollPairingOnce(): Promise<PairingStatus> {
    if (this.authorizedPairing) return this.commitPairing(this.authorizedPairing);
    const pending = this.pendingPairing;
    if (pending === null) return 'idle';
    if (Date.parse(pending.expiresAt) <= Date.now()) {
      this.pendingPairing = null;
      return 'expired';
    }
    const baseUrl = normalizeBaseUrl(this.baseUrl);
    const response = await this.fetchImpl(`${baseUrl}/api/mizar/pairing/poll`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pairingId: pending.pairingId, pollToken: pending.pollToken }),
      signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS),
    }).catch((error: unknown) => {
      this.originalError('pairing', error);
      throw networkError(error);
    });
    if (!response.ok) throw new Error('授权状态暂时无法获取。');
    const value = (await this.readJson(response)) as {
      status?: unknown;
      credential?: unknown;
      installationId?: unknown;
      competitionId?: unknown;
      displayName?: unknown;
      authorizedUser?: unknown;
    };
    if (value.status === 'pending') return 'pending';
    if (value.status === 'expired') {
      this.pendingPairing = null;
      return 'expired';
    }
    if (
      value.status !== 'authorized' ||
      typeof value.credential !== 'string' ||
      !/^rh_mizar_[0-9a-f-]{36}_[0-9a-f]{64}$/i.test(value.credential) ||
      typeof value.installationId !== 'string' ||
      typeof value.competitionId !== 'string'
    )
      throw new Error('授权结果格式无效。');

    const rawDisplayName = typeof value.displayName === 'string' ? value.displayName.trim() : '';
    const displayName = rawDisplayName.length > 0 ? rawDisplayName : '赛事管理员';

    this.authorizedPairing = {
      baseUrl,
      credential: value.credential,
      installationId: value.installationId,
      competitionId: value.competitionId,
      displayName,
      authorizedUser: authorizedUser(value.authorizedUser),
    };
    return this.commitPairing(this.authorizedPairing);
  }

  private async commitPairing(installation: Installation): Promise<PairingStatus> {
    await this.releaseLocked();
    await this.persist(installation);
    this.source = null;
    this.invalidateReadScope();
    this.installation = installation;
    this.authorizedPairing = null;
    this.pendingPairing = null;
    return 'authorized';
  }

  async schedule(from: string, to: string) {
    const generation = ++this.scheduleGeneration;
    const installation = this.installation;
    const response = await this.request(
      `schedule?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    );
    if (!response.ok) throw new Error('赛事赛程暂时无法获取。');
    const result = validateBroadcastScheduleWindow(await this.readJson(response));
    if (!result.ok) throw new Error('赛事赛程格式不兼容。');
    if (
      this.installation &&
      result.value.competition.competitionId === this.installation.competitionId &&
      installation === this.installation &&
      generation === this.scheduleGeneration
    ) {
      // The operator list keeps all provider rows. The internal adjacent-schedule
      // schema has a separate 256-row contract; never serve an older cache as fresh.
      this.scheduleCache = null;
      this.scheduleWarning = null;
      if (result.value.matches.length > 256) {
        this.scheduleWarning = '赛事超过 256 场，完整列表仍可浏览和载入；相邻比赛推荐暂不可用。';
      } else {
        // Schema or identity failures propagate instead of being mistaken for a size limit.
        this.scheduleCache = {
          competitionId: installation.competitionId,
          value: toScheduleWindowV1(result.value),
          acquiredAt: this.monotonicNow(),
        };
      }
      await this.sourceCommands.run(async () => {
        if (this.installation !== installation) return;
        const user = authorizedUser(result.value.viewer);
        await this.persist({ ...installation, authorizedUser: user });
        installation.authorizedUser = user;
      });
    }
    return result.value;
  }

  private browsingLibrary: { installation: Installation; value: RivalHubLibrary } | null = null;
  private libraryScopeId = randomUUID();
  private libraryForCurrentScope() {
    const installation = this.installation;
    if (!installation) throw new Error('请先连接 RivalHub。');
    if (this.browsingLibrary?.installation !== installation) {
      this.libraryScopeId = randomUUID();
      this.scheduleWarning = null;
      this.scheduleCache = null;
      const scope = createHash('sha256')
        .update(
          JSON.stringify([
            installation.baseUrl,
            installation.competitionId,
            installation.installationId,
          ]),
        )
        .digest('hex');
      const current = () => {
        if (this.installation !== installation) throw new Error('赛事连接已变化。');
      };
      this.browsingLibrary = {
        installation,
        value: new RivalHubLibrary(
          `${this.path}.${scope}.library.json`,
          installation.competitionId,
          async (from, to) => {
            current();
            const result = await this.schedule(from, to);
            current();
            return result;
          },
          (matchId, fresh) => {
            current();
            return this.matchSource(matchId, fresh).load();
          },
        ),
      };
    }
    return this.browsingLibrary.value;
  }

  async library() {
    const installation = this.installation;
    const result = await this.libraryForCurrentScope().view();
    if (this.installation !== installation) throw new Error('赛事连接已变化。');
    return {
      ...result,
      library: {
        ...result.library,
        scopeId: this.libraryScopeId,
        scheduleWarning: this.scheduleWarning,
      },
    };
  }

  async libraryDetail(matchId: string, fresh = true) {
    const installation = this.installation;
    const result = await this.libraryForCurrentScope().detail(matchId, fresh);
    if (this.installation !== installation) throw new Error('赛事连接已变化。');
    return result;
  }

  private manifestScope: {
    installation: Installation;
    pending: Map<string, Promise<unknown>>;
    retryState: { notBefore: number };
    abort: AbortController;
    recent: Map<string, { value: unknown; at: number }>;
  } | null = null;

  matchSource(matchId: string, fresh = true) {
    const installation = this.installation;
    if (!installation) throw new Error('请先连接 RivalHub。');
    if (this.manifestScope?.installation !== installation)
      this.manifestScope = {
        installation,
        pending: new Map(),
        retryState: { notBefore: 0 },
        abort: new AbortController(),
        recent: new Map(),
      };
    const scope = this.manifestScope;
    const source = createOnlineManifestSource(matchId, {
      urlTemplate: `${installation.baseUrl}/api/mizar/match?matchId={matchId}`,
      readToken: installation.credential,
      fetchImpl: this.fetchImpl,
      retryState: scope.retryState,
      signal: scope.abort.signal,
      isCurrent: () => this.installation === installation,
    });
    return {
      kind: source.kind,
      load: async () => {
        if (this.installation !== installation)
          throw new SourceLoadError('赛事连接已变化。', undefined, 'authorization');
        let pending = scope.pending.get(matchId);
        const recent = scope.recent.get(matchId);
        // Only overlapping automatic ticks may reuse a just-validated online entity.
        // Explicit browsing, refresh and activation always read fresh (or join an in-flight read).
        if (
          !pending &&
          !fresh &&
          recent &&
          Date.now() >= recent.at &&
          Date.now() - recent.at < 1000
        )
          return structuredClone(recent.value);
        if (!pending) {
          if (scope.pending.size >= 3)
            throw new SourceLoadError('比赛资料正在读取，请稍后重试。', undefined, 'unavailable');
          pending = source
            .load()
            .then((input) => {
              if (this.installation !== installation)
                throw new SourceLoadError('赛事连接已变化。', undefined, 'authorization');
              const valid = validateBroadcastManifest(input);
              if (!valid.ok)
                throw new SourceLoadError('比赛资料格式无效。', undefined, 'invalid_manifest');
              if (
                valid.value.match.matchId !== matchId ||
                valid.value.match.competition?.competitionId !== installation.competitionId
              )
                throw new SourceLoadError('比赛资料不匹配。', undefined, 'match_mismatch');
              scope.recent.delete(matchId);
              scope.recent.set(matchId, { value: valid.value, at: Date.now() });
              while (scope.recent.size > 2) scope.recent.delete(scope.recent.keys().next().value!);
              return valid.value;
            })
            .catch((error: unknown) => {
              scope.recent.delete(matchId);
              throw error;
            })
            .finally(() => scope.pending.delete(matchId));
          scope.pending.set(matchId, pending);
        }
        // Consumers own their entity; never share a one-shot Response or a mutable document.
        return structuredClone(await pending);
      },
    };
  }

  async claim(snapshot: LiveSnapshotV1, contextRevision: string, takeover: boolean) {
    const generation = this.bindingGeneration;
    return this.sourceCommands.run(() =>
      this.claimLocked(snapshot, contextRevision, takeover, generation),
    );
  }

  private async claimLocked(
    snapshot: LiveSnapshotV1,
    contextRevision: string,
    takeover: boolean,
    generation: number,
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
    if (generation !== this.bindingGeneration) throw new Error('比赛已变化，请重新认领数据源。');
    const scope: SourceScope = {
      baseUrl: installation.baseUrl,
      competitionId: installation.competitionId,
      installationId: installation.installationId,
      matchId: snapshot.matchId,
      producerInstanceId: snapshot.cursor.producerInstanceId,
      liveSessionId: snapshot.cursor.liveSessionId,
    };
    const durableState = await this.sourceState.snapshot();
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
    const intent = await this.sourceState.beginClaim(
      scope,
      priorRevisions.length ? Math.max(...priorRevisions) : null,
    );
    if (this.source) this.source.paused = true;
    await this.updateCleanupSummary();
    this.business('business_claim', snapshot, { contextRevision, reason: 'claim_attempt' });
    try {
      const lineupSteam64 = snapshot.players
        .filter(
          (player) => player.lineupEvidence === 'current' && /^\d{17}$/.test(player.sourcePlayerId),
        )
        .map((player) => player.sourcePlayerId);
      const response = await this.request('claim', {
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
      const result = (await this.readJson(response)) as {
        claimed: boolean;
        authorityRevision: number;
        activeDeviceName?: string;
      };
      if (result.claimed === true) {
        if (!Number.isSafeInteger(result.authorityRevision) || result.authorityRevision <= 0)
          throw new Error('数据源授权响应无效，等待核对。');
        const identity = await this.sourceState.confirmClaim(intent.id, result.authorityRevision);
        if (generation !== this.bindingGeneration) {
          await this.sourceState.handoff(identity, 'switch');
          // The previous source may still own an unsettled tail. Keep its
          // exact identity fenced until its own cleanup has confirmed release.
          if (this.source) {
            this.source.draining = true;
            this.source.paused = true;
          }
          await this.updateCleanupSummary();
          throw new Error('比赛已变化，原数据源待释放。');
        }
        await this.updateCleanupSummary();
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
        this.source = {
          matchId: snapshot.matchId,
          authorityRevision: result.authorityRevision,
          producerInstanceId: snapshot.cursor.producerInstanceId,
          liveSessionId: snapshot.cursor.liveSessionId,
        };
        this.activeDeviceName = null;
        this.activeDeviceMatchId = null;
      } else if (result.claimed === false) {
        await this.sourceState.clearIntent(intent.id);
        await this.updateCleanupSummary();
        if (generation !== this.bindingGeneration)
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
      this.business('business_claim', snapshot, {
        contextRevision,
        reason: requestFailureReason(error),
        causeCode: requestFailureCode(error),
      });
      throw error;
    }
  }

  async release(): Promise<void> {
    return this.sourceCommands.run(() => this.releaseLocked());
  }

  private async releaseLocked(): Promise<void> {
    const deadline = Date.now() + 8000;
    await this.retireCurrent('finish');
    await this.cleanup(true, deadline);
    if (
      this.cleanupSummary.pending ||
      this.cleanupSummary.blocked ||
      this.cleanupSummary.claimIntent
    )
      throw new Error('数据源释放待重试或核对。');
  }

  private async upload(
    operation: 'reliable',
    body: unknown,
    matchId: string,
    signal?: AbortSignal,
    isCurrent: () => boolean = () => true,
  ): Promise<ReliableDeliveryResult> {
    const event = (body as { event: ReliableEventV1 }).event;
    const evidence = (fields: Record<string, unknown>) =>
      this.business('business_reliable', event, {
        idempotencyKey: event.idempotencyKey,
        eventKind: event.kind,
        originalObservedAt: event.observedAt,
        ...fields,
      });
    if (!this.source) {
      evidence({ reason: 'source_unavailable' });
      return 'retry';
    }
    if (this.source.matchId !== matchId) return 'rejected';
    const source = this.source;
    try {
      if (signal?.aborted || !isCurrent()) return 'retry';
      evidence({ reason: 'request_started', sentAt: new Date().toISOString() });
      const response = await this.request(operation, {
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
      if (event.kind === 'map_started' && source.deliveryExecution === executionKey(event.cursor)) {
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
      if (response.status === 403) {
        if (this.source === source) {
          source.paused = true;
        }
        return 'rejected';
      }
      return response.status === 408 || response.status === 429 || response.status >= 500
        ? 'retry'
        : (rejection ?? 'rejected');
    } catch (error) {
      if (
        isCurrent() &&
        !signal?.aborted &&
        event.kind === 'map_started' &&
        source.deliveryExecution === executionKey(event.cursor)
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
      this.business('business_live', snapshot, { reason: 'source_unavailable' });
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

  async sendReliable(
    event: ReliableEventV1,
    current: LiveSnapshotV1 | null,
    signal: AbortSignal = AbortSignal.timeout(RELIABLE_SEND_TIMEOUT_MS),
    retainedLineup?: readonly string[],
  ): Promise<ReliableDeliveryResult> {
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
