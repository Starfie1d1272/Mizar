import { randomUUID } from 'node:crypto';
import { readFile, rename, writeFile, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import type { LiveSnapshotV1, ReliableEventV1 } from '@mizar/protocol/output';
import type { ScheduleWindowV1 } from '@mizar/core/match-context';
import { toScheduleWindowV1, validateBroadcastScheduleWindow } from '@mizar/rivalhub';
import { createOnlineManifestSource } from './http-source.js';
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
};

function executionKey(cursor: LiveSnapshotV1['cursor']): string {
  return JSON.stringify([
    cursor.producerInstanceId,
    cursor.liveSessionId,
    cursor.programSourceGeneration,
    cursor.mapEpoch,
  ]);
}

function networkError(error: unknown): unknown {
  if (error instanceof Error && error.name === 'TimeoutError')
    return new Error('连接 RivalHub 超时，请检查网络后重试。', { cause: error });
  if (error instanceof TypeError)
    return new Error('连接 RivalHub 失败，请检查网络后重试。', { cause: error });
  return error;
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
  private scheduleGeneration = 0;
  private scheduleCache: {
    competitionId: string;
    value: ScheduleWindowV1;
    acquiredAt: number;
  } | null = null;
  getSchedule(): ScheduleWindowV1 | null {
    return this.installation &&
      this.scheduleCache?.competitionId === this.installation.competitionId &&
      performance.now() - this.scheduleCache.acquiredAt < 60_000
      ? this.scheduleCache.value
      : null;
  }
  private installation: Installation | null = null;
  private pendingPairing: PendingPairing | null = null;
  private pairingPoll: Promise<PairingStatus> | null = null;
  private source: Source | null = null;
  private activeDeviceName: string | null = null;
  private claimRevision = 0;
  private liveDelivery: {
    status: 'idle' | 'accepted' | 'dropped' | 'failing';
    reason: string | null;
    consecutiveFailures: number;
    since: number | null;
    notified: boolean;
  } = {
    status: 'idle',
    reason: null,
    consecutiveFailures: 0,
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
      pairing: this.pendingPairing === null ? 'idle' : 'pending',
      liveDelivery:
        this.source === null
          ? { status: 'idle', reason: null, consecutiveFailures: 0, durationMs: 0 }
          : {
              status: this.liveDelivery.status,
              reason: this.liveDelivery.reason,
              consecutiveFailures: this.liveDelivery.consecutiveFailures,
              durationMs:
                this.liveDelivery.since === null
                  ? 0
                  : Math.max(0, performance.now() - this.liveDelivery.since),
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
        const reader = (response.body as ReadableStream<Uint8Array> | null)?.getReader();
        let detail = '';
        if (reader) {
          try {
            const decoder = new TextDecoder();
            while (detail.length < 4096) {
              const chunk = await reader.read();
              if (chunk.done) break;
              detail += decoder.decode(chunk.value.subarray(0, 4096), { stream: true });
            }
          } finally {
            await reader.cancel();
            reader.releaseLock();
          }
        }
        this.onDiagnostic(
          operation,
          new Error(`RivalHub HTTP ${response.status}: ${detail.slice(0, 4096)}`),
        );
      }
      return response;
    } catch (error) {
      this.onDiagnostic(operation, error);
      throw networkError(error);
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
    const value = (await response.json()) as {
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
    const value = (await response.json()) as {
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
    const result = validateBroadcastScheduleWindow(await response.json());
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
        acquiredAt: performance.now(),
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
        lineupSteam64: lineupSteam64.length === 10 ? lineupSteam64 : [],
      }),
    });
    if (!response.ok) throw new Error('当前比赛无法成为数据源，请刷新比赛资料并核对首发。');
    const result = (await response.json()) as {
      claimed: boolean;
      authorityRevision: number;
      activeDeviceName?: string;
    };
    if (result.claimed) {
      this.liveDelivery = {
        status: 'idle',
        reason: null,
        consecutiveFailures: 0,
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
    } else {
      this.source = null;
      this.activeDeviceName = result.activeDeviceName ?? '另一台制播设备';
    }
    return this.view();
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
    if (!this.source) return 'retry';
    if (this.source.matchId !== matchId) return 'rejected';
    const source = this.source;
    try {
      if (signal?.aborted || !isCurrent()) return 'retry';
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
      if (response.ok) return 'accepted';
      if (response.status === 403) {
        if (this.source === source) {
          this.source = null;
          this.activeDeviceName = '另一台制播设备';
        }
        return 'rejected';
      }
      return response.status === 408 || response.status === 429 || response.status >= 500
        ? 'retry'
        : 'rejected';
    } catch {
      return 'retry';
    }
  }

  async sendLive(snapshot: LiveSnapshotV1): Promise<void> {
    // Claiming a source does not establish the website's map/identity evidence.
    // Keep the disposable lane behind the reliable start acknowledgement, also
    // after re-claim, generation advance and map change. No old snapshot is queued.
    if (this.source?.acknowledgedExecution !== executionKey(snapshot.cursor))
      throw new Error('rivalhub_map_start_pending');
    const source = this.source;
    if (!source || source.matchId !== snapshot.matchId)
      throw new Error('rivalhub_live_unavailable');
    let reason = 'transport_failed';
    let accepted = false;
    let dropped = false;
    let lostAuthority = false;
    try {
      // LIVE is disposable: one bounded request, no retries and no response payload logging.
      const response = await this.fetchImpl(`${this.installation!.baseUrl}/api/mizar/live`, {
        method: 'POST',
        redirect: 'manual',
        signal: AbortSignal.timeout(4000),
        headers: {
          authorization: `Bearer ${this.installation!.credential}`,
          'content-type': 'application/json',
          'x-rivalhub-authority': String(source.authorityRevision),
        },
        body: JSON.stringify(snapshot),
      });
      if (response.ok || response.status === 429) {
        // Bounded response consumption; remote details/URLs are never diagnostics.
        const reader = (response.body as ReadableStream<Uint8Array> | null)?.getReader();
        let text = '';
        let bytes = 0;
        try {
          if (reader)
            for (;;) {
              const chunk = await reader.read();
              if (chunk.done) break;
              bytes += chunk.value.byteLength;
              if (bytes > 4096) throw new Error('live_response_too_large');
              text += new TextDecoder().decode(chunk.value);
            }
        } finally {
          await reader?.cancel();
        }
        const result = JSON.parse(text) as { accepted?: unknown; reason?: unknown };
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
        await response.body?.cancel();
      }
    } catch {
      /* A newer frame may recover; never resend this frame. */
    }
    if (this.source !== source) throw new Error('rivalhub_live_unavailable');
    if (lostAuthority) {
      this.source = null;
      this.activeDeviceName = '另一台制播设备';
    }
    const previous = this.liveDelivery;
    if (accepted || dropped) {
      if (accepted && previous.notified)
        this.onDiagnostic('live_recovered', new Error('RivalHub LIVE 投递已恢复。'));
      this.liveDelivery = {
        status: accepted ? 'accepted' : 'dropped',
        reason: accepted ? null : reason,
        consecutiveFailures: 0,
        since: null,
        notified: false,
      };
      return;
    }
    this.liveDelivery = {
      status: 'failing',
      reason,
      consecutiveFailures: previous.consecutiveFailures + 1,
      since: previous.since ?? performance.now(),
      notified: previous.notified,
    };
    const duration = performance.now() - this.liveDelivery.since!;
    let newlyNotified = false;
    if (
      !this.liveDelivery.notified &&
      this.liveDelivery.consecutiveFailures >= 5 &&
      duration >= 10_000
    ) {
      this.liveDelivery.notified = true;
      newlyNotified = true;
      this.onDiagnostic(
        'live',
        new Error(
          `RivalHub LIVE 持续未接收：${reason}；count=${this.liveDelivery.consecutiveFailures}；durationMs=${Math.round(duration)}`,
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
    const source = this.source;
    // Durable recovery keeps the original producer evidence. A new claim cannot
    // authorize that old producer, even when the live session was restored.
    if (
      source &&
      (source.producerInstanceId !== event.cursor.producerInstanceId ||
        source.liveSessionId !== event.cursor.liveSessionId)
    )
      return 'rejected';
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
    if (source && attempt) source.mapStartAttempt = attempt;
    const isCurrent = () =>
      this.source === source && (attempt === undefined || source?.mapStartAttempt === attempt);
    const result = await this.upload(
      'reliable',
      { event, lineupSteam64: observed.length === 10 ? observed : [] },
      event.matchId,
      signal,
      isCurrent,
    );
    if (result === 'accepted' && attempt && source && isCurrent() && !signal.aborted)
      source.acknowledgedExecution = executionKey(event.cursor);
    return result;
  }
}
