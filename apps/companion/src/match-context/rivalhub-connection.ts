import { randomUUID } from 'node:crypto';
import { readFile, rename, writeFile, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import type { LiveSnapshotV1, ReliableEventV1 } from '@mizar/protocol/output';
import type { ScheduleWindowV1 } from '@mizar/core/match-context';
import { toScheduleWindowV1, validateBroadcastScheduleWindow } from '@mizar/rivalhub';
import { createOnlineManifestSource } from './http-source.js';
import { redactDiagnosticText, diagnosticNetworkCode } from '../updates/diagnostics.js';
import {
  RELIABLE_SEND_TIMEOUT_MS,
  type ReliableDeliveryResult,
} from '../output/reliable-outbox.js';

type Installation = {
  baseUrl: string;
  credential: string;
  installationId: string;
  competitionId: string;
  displayName: string;
};
type PendingPairing = {
  pairingId: string;
  pollToken: string;
  expiresAt: string;
};
export const OFFICIAL_RIVALHUB_URL = 'https://match.starfie1d.top';
const CONTROL_TIMEOUT_MS = 15_000;
type PairingStatus = 'idle' | 'pending' | 'expired' | 'authorized';
type Source = {
  matchId: string;
  authorityRevision: number;
  producerInstanceId: string;
  liveSessionId: string;
  acknowledgedExecution?: string;
  mapStartAttempt?: symbol;
  deliveryExecution?: string;
};

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
function requestFailureCode(error: unknown): string | undefined {
  if (error instanceof Error && 'rootCauseCode' in error) {
    const code = diagnosticNetworkCode(error.rootCauseCode);
    if (code) return code;
  }
  const root = (evidence: LiveErrorEvidence): string | undefined =>
    (evidence.cause ? root(evidence.cause) : undefined) ?? diagnosticNetworkCode(evidence.code);
  return root(liveErrorEvidence(error));
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

/** Companion-owned scoped installation. Never exposed to the browser. */
export class RivalHubConnection {
  private onDiagnostic: (operation: string, error: unknown) => void = () => {};
  setDiagnosticHandler(handler: (operation: string, error: unknown) => void): void {
    this.onDiagnostic = handler;
  }
  private businessHandler: ((stage: string, evidence: unknown) => void) | undefined;
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
  private installation: Installation | null = null;
  private pendingPairing: PendingPairing | null = null;
  private pairingPoll: Promise<PairingStatus> | null = null;
  private source: Source | null = null;
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
  private syncWatch: {
    key: string;
    matchId: string;
    since: number;
    incidentId: string | null;
  } | null = null;
  private lastAcceptedAt = 0;

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
    if (current && this.liveDelivery.status === 'accepted' && now - this.lastAcceptedAt < 15_000) {
      watch.since = now;
      watch.incidentId = null;
      return result('healthy');
    }
    const reason =
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

  retryLive(): void {
    this.nextLiveAt = 0;
    this.liveFailures = 0;
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
  ) {}

  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8')) as Installation;
      if (
        typeof parsed.credential === 'string' &&
        typeof parsed.installationId === 'string' &&
        typeof parsed.competitionId === 'string'
      )
        this.installation = { ...parsed, baseUrl: normalizeBaseUrl(parsed.baseUrl) };
    } catch {
      /* Missing or invalid connection is an unpaired local mode. */
    }
  }

  view() {
    return {
      paired: this.installation !== null,
      competitionId: this.installation?.competitionId ?? null,
      displayName: this.installation?.displayName ?? null,
      activeSourceMatchId: this.source?.matchId ?? null,
      activeDeviceName: this.activeDeviceName,
      activeDeviceMatchId: this.activeDeviceMatchId,
      pairing: this.pendingPairing === null ? 'idle' : 'pending',
      stoppedMatchId: this.stoppedMatchId,
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

  async disconnect(): Promise<void> {
    if (this.installation) {
      try {
        await this.release();
      } catch {
        // active source release is best-effort
      }
      const response = await this.request('disconnect', {
        method: 'POST',
      });
      await response.body?.cancel();
      if (!response.ok) {
        throw new Error('断开连接失败，请稍后重试。');
      }
    }
    await unlink(this.path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
    this.installation = null;
    this.scheduleCache = null;
    this.source = null;
    this.activeDeviceName = null;
    this.pendingPairing = null;
  }

  private async persist(): Promise<void> {
    if (!this.installation) return;
    await mkdir(dirname(this.path), { recursive: true });
    const temp = join(dirname(this.path), `.rivalhub-${randomUUID()}.tmp`);
    await writeFile(temp, JSON.stringify(this.installation), { mode: 0o600 });
    await rename(temp, this.path);
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
      if (!response.ok) {
        await response.body?.cancel();
        this.onDiagnostic(operation, new Error(`RivalHub HTTP ${response.status}`));
      }
      return response;
    } catch (error) {
      const safe = networkError(error);
      this.onDiagnostic(operation, safe);
      throw safe;
    }
  }

  private async readJson(response: Response): Promise<unknown> {
    try {
      return await response.json();
    } catch (error) {
      // JSON parser/read errors may quote credentials or arbitrary remote bytes.
      // Never attach the original error as cause or log it at this boundary.
      throw new RivalHubResponseError(error instanceof SyntaxError ? 'parse' : 'read');
    }
  }

  async startPairing(): Promise<{ authorizeUrl: string; expiresAt: string }> {
    const baseUrl = normalizeBaseUrl(this.baseUrl);
    const response = await this.fetchImpl(`${baseUrl}/api/mizar/pairing/start`, {
      method: 'POST',
      redirect: 'manual',
      signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS),
    }).catch((error: unknown) => {
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
    return { authorizeUrl: authorizeUrl.toString(), expiresAt: value.expiresAt };
  }

  pollPairing(): Promise<PairingStatus> {
    if (!this.pairingPoll)
      this.pairingPoll = this.pollPairingOnce().finally(() => {
        this.pairingPoll = null;
      });
    return this.pairingPoll;
  }

  private async pollPairingOnce(): Promise<PairingStatus> {
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
      throw networkError(error);
    });
    if (!response.ok) throw new Error('授权状态暂时无法获取。');
    const value = (await this.readJson(response)) as {
      status?: unknown;
      credential?: unknown;
      installationId?: unknown;
      competitionId?: unknown;
      displayName?: unknown;
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

    try {
      await this.release();
    } catch {
      // Safe cleanup by correct owner: new installation persistence must not be blocked by release failure
    }
    this.source = null;
    this.installation = {
      baseUrl,
      credential: value.credential,
      installationId: value.installationId,
      competitionId: value.competitionId,
      displayName,
    };
    await this.persist();
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
    )
      this.scheduleCache = {
        competitionId: this.installation.competitionId,
        value: toScheduleWindowV1(result.value),
        acquiredAt: this.monotonicNow(),
      };
    return result.value;
  }

  matchSource(matchId: string) {
    if (!this.installation) throw new Error('请先连接 RivalHub。');
    return createOnlineManifestSource(matchId, {
      urlTemplate: `${this.installation.baseUrl}/api/mizar/match?matchId={matchId}`,
      readToken: this.installation.credential,
      fetchImpl: this.fetchImpl,
    });
  }

  async claim(snapshot: LiveSnapshotV1, contextRevision: string, takeover: boolean) {
    if (
      !this.installation ||
      snapshot.competitionId !== this.installation.competitionId ||
      !snapshot.cursor.liveSessionId
    )
      throw new Error('当前比赛尚未准备好连接。');
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
      if (result.claimed) {
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
      } else {
        this.source = null;
        this.activeDeviceName = result.activeDeviceName ?? '另一台制播设备';
        this.activeDeviceMatchId = snapshot.matchId;
      }
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
    if (!this.source) return;
    const source = this.source;
    const response = await this.request('release', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-rivalhub-authority': String(source.authorityRevision),
      },
      body: JSON.stringify({
        matchId: source.matchId,
        producerInstanceId: source.producerInstanceId,
        liveSessionId: source.liveSessionId,
      }),
    });
    await response.body?.cancel();
    if (!response.ok) throw new Error('当前数据源停止未确认。');
    // Only clear the binding that was actually released. A concurrent claim may
    // already have installed a newer local source while this request was in flight.
    if (this.source === source) this.source = null;
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
      await response.body?.cancel();
      if (signal?.aborted || !isCurrent()) return 'retry';
      evidence({
        reason: response.ok ? 'receiver_accepted' : `http_${response.status}`,
        httpStatus: response.status,
        acknowledgedAt: response.ok ? new Date().toISOString() : null,
      });
      if (response.ok) return 'accepted';
      if (event.kind === 'map_started' && source.deliveryExecution === executionKey(event.cursor)) {
        this.controlFailureScope = this.failureScope(event);
        this.controlFailure =
          response.status === 401
            ? 'authorization_expired'
            : response.status === 403
              ? 'permission_denied'
              : response.status === 409
                ? 'context_conflict'
                : `http_${response.status}`;
      }
      if (response.status === 403) {
        if (this.source === source) {
          this.source = null;
        }
        return 'rejected';
      }
      return response.status === 408 || response.status === 429 || response.status >= 500
        ? 'retry'
        : 'rejected';
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
    // Claiming a source does not establish the website's map/identity evidence.
    // Keep the disposable lane behind the reliable start acknowledgement, also
    // after re-claim, generation advance and map change. No old snapshot is queued.
    const source = this.source;
    if (this.stoppedMatchId === snapshot.matchId) return;
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
      this.source = null;
    }
    this.business('business_live', snapshot, {
      reason: accepted ? 'receiver_accepted' : reason,
      failureStage: failure?.stage,
      causeCode: failure?.error.cause?.code ?? failure?.error.code,
      sentAt,
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
      this.liveFailures += 1;
      this.nextLiveAt =
        this.monotonicNow() + Math.min(8_000, 500 * 2 ** Math.min(this.liveFailures, 4));
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
  ): Promise<ReliableDeliveryResult> {
    if (this.stoppedMatchId === event.matchId) return 'retry';
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
    const observed = sameExecution
      ? current.players
          .filter(
            (player) =>
              player.lineupEvidence === 'current' && /^\d{17}$/.test(player.sourcePlayerId),
          )
          .map((player) => player.sourcePlayerId)
      : [];
    if (signal.aborted) return 'retry';
    const attempt = event.kind === 'map_started' ? Symbol('map_start') : undefined;
    if (source && attempt) {
      source.mapStartAttempt = attempt;
      if (sameExecution) this.beginDeliveryExecution(source, event.cursor);
    }
    const isCurrent = () =>
      this.stoppedMatchId !== event.matchId &&
      this.source === source &&
      (attempt === undefined || source?.mapStartAttempt === attempt);
    const result = await this.upload(
      'reliable',
      { event, lineupSteam64: observed.length === 10 ? observed : [] },
      event.matchId,
      signal,
      isCurrent,
    );
    if (attempt && source && isCurrent() && !signal.aborted) {
      if (result === 'accepted') {
        source.acknowledgedExecution = executionKey(event.cursor);
        if (source.deliveryExecution === executionKey(event.cursor)) this.controlFailure = null;
      } else if (
        result === 'rejected' &&
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
