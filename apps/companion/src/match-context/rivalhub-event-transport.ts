import type { LiveSnapshotV1, ReliableEventV2 } from '@mizar/protocol/output';
import {
  RELIABLE_SEND_TIMEOUT_MS,
  type ReliableDeliveryResult,
} from '../output/reliable-delivery.js';
import type { RivalHubAuthorization } from './rivalhub-authorization.js';
import {
  liveErrorEvidence,
  liveTimeout,
  readReliableBody,
  requestFailureCode,
  requestFailureReason,
  rootNetworkCode,
  type LiveErrorEvidence,
} from './rivalhub-http-errors.js';
import { executionKey } from './rivalhub-source-recovery.js';
import { sameExactSource, type ExactSource, type SourceScope } from './rivalhub-source-state.js';

export type LiveFailure = {
  stage: 'fetch' | 'response' | 'read' | 'validate' | 'cancel' | 'parse' | 'acceptance';
  httpStatus?: number;
  serverDate?: string | null;
  sentAt?: string;
  body?: string | null;
  error?: LiveErrorEvidence;
};

export interface LiveDeliveryState {
  status: 'idle' | 'accepted' | 'dropped' | 'failing';
  cursor: LiveSnapshotV1['cursor'] | null;
  reason: string | null;
  failure?: LiveFailure;
  consecutiveUnaccepted: number;
  since: number | null;
  notified: boolean;
}

export interface RivalHubDeliveryState {
  controlFailure: string | null;
  controlFailureKey: string | null;
  nextLiveAt: number;
  liveFailures: number;
  liveFailureKind: 'transport' | 'receiver' | null;
  lastAcceptedAt: number;
  liveDelivery: LiveDeliveryState;
}

export type RivalHubTransportSource = ExactSource & {
  deliveryExecution?: string;
  paused?: boolean;
  livePaused?: boolean;
  draining?: boolean;
};

export interface RivalHubEventTransportHost {
  readonly authorization: Pick<RivalHubAuthorization, 'request'>;
  readonly fetchImpl: typeof fetch;
  installation: () => { baseUrl: string; credential: string; installationId: string } | null;
  source: () => RivalHubTransportSource | null;
  stoppedMatchId: () => string | null;
  monotonicNow: () => number;
  requireSourceState: () => void;
  isCurrentInstallation: (scope: SourceScope) => boolean;
  business: (
    stage: 'business_live' | 'business_reliable',
    payload: LiveSnapshotV1 | ReliableEventV2,
    fields: Record<string, unknown>,
  ) => void;
  onDiagnostic: (operation: string, error: unknown) => void;
  originalError: (operation: string, error: unknown) => void;
  failureExecutionKey: (payload: LiveSnapshotV1) => string;
}

/** Owns HTTP LIVE and reliable event delivery for an active or retained RivalHub source. */
function httpControlFailure(status: number): string {
  if (status === 401) return 'authorization_expired';
  if (status === 403) return 'permission_denied';
  if (status === 409) return 'context_conflict';
  return `http_${status}`;
}

export class RivalHubEventTransport {
  private readonly liveInFlight = new Map<RivalHubTransportSource, Set<Promise<void>>>();
  private readonly state: RivalHubDeliveryState = {
    controlFailure: null,
    controlFailureKey: null,
    nextLiveAt: 0,
    liveFailures: 0,
    liveFailureKind: null,
    lastAcceptedAt: 0,
    liveDelivery: {
      cursor: null,
      status: 'idle',
      reason: null,
      consecutiveUnaccepted: 0,
      since: null,
      notified: false,
    },
  };

  constructor(private readonly host: RivalHubEventTransportHost) {}

  setControlFailure(key: string, reason: string | null): void {
    this.state.controlFailureKey = key;
    this.state.controlFailure = reason;
  }

  controlFailureFor(key: string): string | null {
    return this.state.controlFailureKey === key ? this.state.controlFailure : null;
  }

  resetLiveBackoff(): void {
    this.state.nextLiveAt = 0;
    this.state.liveFailures = 0;
    this.state.liveFailureKind = null;
  }

  resetForNewClaim(): void {
    this.state.controlFailure = null;
    this.resetLiveBackoff();
    this.state.liveDelivery = {
      cursor: null,
      status: 'idle',
      reason: null,
      consecutiveUnaccepted: 0,
      since: null,
      notified: false,
    };
  }

  liveDeliveryView(now: number) {
    return {
      status: this.state.liveDelivery.status,
      cursor: this.state.liveDelivery.cursor,
      reason: this.state.liveDelivery.reason,
      failure: this.state.liveDelivery.failure ?? null,
      consecutiveUnaccepted: this.state.liveDelivery.consecutiveUnaccepted,
      durationMs:
        this.state.liveDelivery.since === null
          ? 0
          : Math.max(0, now - this.state.liveDelivery.since),
    };
  }

  liveStatusForCursor(cursorKey: string, now: number) {
    const matchesCursor = Boolean(
      this.state.liveDelivery.cursor && executionKey(this.state.liveDelivery.cursor) === cursorKey,
    );
    return {
      matchesCursor,
      recentlyAccepted:
        matchesCursor &&
        this.state.liveDelivery.status === 'accepted' &&
        now - this.state.lastAcceptedAt < 15_000,
      reason: this.state.liveDelivery.reason,
    };
  }

  async awaitLiveInFlight(identity: ExactSource): Promise<void> {
    const requests = [...this.liveInFlight.entries()]
      .filter(([source]) => sameExactSource(source, identity))
      .flatMap(([, pending]) => [...pending]);
    await Promise.allSettled(requests);
  }

  async sendReliableV2(
    event: ReliableEventV2,
    signal: AbortSignal = AbortSignal.timeout(RELIABLE_SEND_TIMEOUT_MS),
  ): Promise<ReliableDeliveryResult> {
    const evidence = (fields: Record<string, unknown>) =>
      this.host.business('business_reliable', event, {
        idempotencyKey: event.idempotencyKey,
        eventKind: event.kind,
        originalObservedAt: event.observedAt,
        authorityRevision: event.session.authorityRevision,
        ...fields,
      });
    if (!this.host.installation()) {
      evidence({ reason: 'installation_missing' });
      return { status: 'retry', error: 'installation_missing' };
    }
    try {
      if (signal.aborted) return { status: 'retry', error: 'aborted' };
      evidence({ reason: 'request_started', sentAt: new Date().toISOString() });
      const response = await this.host.authorization.request('reliable-v2', {
        signal,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-rivalhub-authority': String(event.session.authorityRevision),
        },
        body: JSON.stringify(event),
      });
      const readBody =
        response.ok ||
        (response.status !== 408 && response.status !== 429 && response.status < 500);
      const responseData = readBody ? await readReliableBody(response) : undefined;
      if (!readBody) await response.body?.cancel().catch(() => undefined);
      const bodyObj =
        responseData !== null && typeof responseData === 'object' && !Array.isArray(responseData)
          ? (responseData as Record<string, unknown>)
          : undefined;
      const needsAttention = response.ok && bodyObj?.outcome === 'needs_attention';
      const warning =
        response.ok && typeof bodyObj?.warning === 'string' && bodyObj.warning
          ? bodyObj.warning
          : undefined;
      const rejectionReason =
        !response.ok && typeof bodyObj?.reason === 'string' && bodyObj.reason
          ? bodyObj.reason
          : !response.ok && typeof bodyObj?.error === 'string' && bodyObj.error
            ? bodyObj.error
            : undefined;
      evidence({
        receiverOutcome: needsAttention ? 'needs_attention' : undefined,
        warning,
        rejectionReason,
        reason: response.ok ? 'receiver_accepted' : `http_${response.status}`,
        httpStatus: response.status,
        acknowledgedAt: response.ok ? new Date().toISOString() : null,
      });
      if (response.ok) {
        return {
          status: 'accepted',
          ...(needsAttention ? { outcome: 'needs_attention' as const } : {}),
          ...(warning ? { warning } : {}),
        };
      }
      if (response.status === 408 || response.status === 429 || response.status >= 500) {
        return { status: 'retry', error: `http_${response.status}` };
      }
      return {
        status: 'rejected',
        error: rejectionReason ?? `http_${response.status}`,
      };
    } catch (error) {
      const reason = signal.aborted
        ? requestFailureReason(signal.reason) === 'timeout'
          ? 'timeout'
          : 'request_aborted'
        : requestFailureReason(error);
      evidence({
        reason,
        causeCode: requestFailureCode(error),
      });
      return { status: 'retry', error: reason };
    }
  }

  beginDeliveryExecution(source: RivalHubTransportSource, cursor: LiveSnapshotV1['cursor']): void {
    const execution = executionKey(cursor);
    if (source.deliveryExecution === execution) return;
    source.deliveryExecution = execution;
    this.resetLiveBackoff();
    this.state.liveDelivery = {
      cursor,
      status: 'idle',
      reason: null,
      consecutiveUnaccepted: 0,
      since: null,
      notified: false,
    };
  }

  async sendLive(snapshot: LiveSnapshotV1): Promise<void> {
    this.host.requireSourceState();
    const source = this.host.source();
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
    const source = this.host.source();
    if (
      this.host.stoppedMatchId() === snapshot.matchId ||
      source?.paused ||
      source?.livePaused ||
      source?.draining
    )
      return;
    if (
      !source ||
      source.matchId !== snapshot.matchId ||
      source.producerInstanceId !== snapshot.cursor.producerInstanceId ||
      source.liveSessionId !== snapshot.cursor.liveSessionId
    ) {
      this.host.business('business_live', snapshot, {
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
    if (this.host.monotonicNow() < this.state.nextLiveAt) return;
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
      const response = await this.host.fetchImpl(
        `${this.host.installation()!.baseUrl}/api/mizar/live`,
        {
          method: 'POST',
          redirect: 'manual',
          signal,
          headers: {
            authorization: `Bearer ${this.host.installation()!.credential}`,
            'content-type': 'application/json',
            'x-rivalhub-authority': String(source.authorityRevision),
          },
          body: JSON.stringify(snapshot),
        },
      );
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
      this.host.originalError('live', error);
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
    if (this.host.source() !== source || source.deliveryExecution !== execution)
      throw new Error('rivalhub_live_unavailable');
    if (lostAuthority) {
      source.livePaused = true;
    }
    this.host.business('business_live', snapshot, {
      reason: accepted ? 'receiver_accepted' : reason,
      failureStage: failure?.stage,
      causeCode: failure?.error?.cause?.code ?? failure?.error?.code,
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
    const previous = this.state.liveDelivery;
    if (accepted) {
      this.state.controlFailure = null;
      this.state.lastAcceptedAt = this.host.monotonicNow();
      this.resetLiveBackoff();
      if (previous.notified)
        this.host.onDiagnostic('live_recovered', new Error('RivalHub LIVE 投递已恢复。'));
      this.state.liveDelivery = {
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
      const code = failure?.error ? rootNetworkCode(failure.error) : undefined;
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
      this.state.liveFailures =
        this.state.liveFailureKind === kind ? this.state.liveFailures + 1 : 1;
      this.state.liveFailureKind = kind;
      this.state.nextLiveAt =
        this.host.monotonicNow() +
        Math.min(transientNetwork ? 2_000 : 8_000, 500 * 2 ** Math.min(this.state.liveFailures, 4));
      this.state.controlFailureKey = this.host.failureExecutionKey(snapshot);
      this.state.controlFailure = /^http_\d+$/.test(reason)
        ? httpControlFailure(Number(reason.slice(5)))
        : reason;
    }
    this.state.liveDelivery = {
      cursor: snapshot.cursor,
      status: dropped && previous.status !== 'failing' ? 'dropped' : 'failing',
      reason,
      consecutiveUnaccepted: previous.consecutiveUnaccepted + 1,
      since: previous.since ?? this.host.monotonicNow(),
      notified: previous.notified,
      ...(failure ? { failure } : previous.failure ? { failure: previous.failure } : {}),
    };
    const duration = this.host.monotonicNow() - this.state.liveDelivery.since!;
    let newlyNotified = false;
    if (
      !this.state.liveDelivery.notified &&
      this.state.liveDelivery.consecutiveUnaccepted >= 5 &&
      duration >= 10_000
    ) {
      this.state.liveDelivery.status = 'failing';
      this.state.liveDelivery.notified = true;
      newlyNotified = true;
      this.host.onDiagnostic(
        'live',
        new Error(
          `RivalHub LIVE 持续未接收：${reason}；count=${this.state.liveDelivery.consecutiveUnaccepted}；durationMs=${Math.round(duration)}；stage=${this.state.liveDelivery.failure?.stage ?? 'acceptance'}`,
          { cause: this.state.liveDelivery.failure },
        ),
      );
    }
    if (lostAuthority || newlyNotified) throw new Error('rivalhub_live_unavailable');
  }
}
