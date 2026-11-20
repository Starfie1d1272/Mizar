import type { LiveSnapshotV1 } from '@mizar/protocol/output';
import {
  sameScope,
  type ClaimIntent,
  type ExactSource,
  type SourceRecord,
  type SourceScope,
} from './rivalhub-source-state.js';

/** Only explicit, structured receiver refusals prove that this claim did not commit. */
export function definitiveClaimRejection(response: Response, body: unknown): boolean {
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

export function executionKey(cursor: LiveSnapshotV1['cursor']): string {
  return JSON.stringify([
    cursor.producerInstanceId,
    cursor.liveSessionId,
    cursor.programSourceGeneration,
    cursor.mapEpoch,
  ]);
}

export function sourceStatusRequest(scope: SourceScope, authorityRevision?: number): string {
  const query = new URLSearchParams({
    matchId: scope.matchId,
    producerInstanceId: scope.producerInstanceId,
    liveSessionId: scope.liveSessionId,
  });
  if (authorityRevision !== undefined) query.set('authorityRevision', String(authorityRevision));
  return `source-status?${query}`;
}

/** A status reply proves only the identity and authority it explicitly returned. */
export function confirmedSourceStatus(body: unknown, scope: SourceScope) {
  const result = body as { status?: unknown; source?: Record<string, unknown> } | undefined;
  const source = result?.source;
  if (
    result?.status !== 'found' ||
    !source ||
    source.installationId !== scope.installationId ||
    source.competitionId !== scope.competitionId ||
    source.matchId !== scope.matchId ||
    source.producerInstanceId !== scope.producerInstanceId ||
    source.liveSessionId !== scope.liveSessionId ||
    typeof source.authorityRevision !== 'number' ||
    !Number.isSafeInteger(source.authorityRevision) ||
    source.authorityRevision <= 0 ||
    (source.state !== 'open' && source.state !== 'closed')
  )
    return;
  return { authorityRevision: source.authorityRevision, state: source.state };
}

export function confirmsClosedSource(body: unknown, identity: ExactSource): boolean {
  const status = confirmedSourceStatus(body, identity);
  return status?.state === 'closed' && status.authorityRevision === identity.authorityRevision;
}

/** Match a receipt to the durable request before using any authority it reports. */
export function claimRecoveryProof(
  body: unknown,
  intent: ClaimIntent,
  legacyScopeRecovery: boolean,
) {
  const receipt = body as
    | { status?: unknown; claimRequestId?: unknown; scope?: Omit<SourceScope, 'baseUrl'> }
    | undefined;
  if (intent.claimRecoveryVersion) {
    if (receipt?.claimRequestId !== intent.id) return;
    if (receipt.status === 'cancelled') return { kind: 'clear' } as const;
  } else if (
    legacyScopeRecovery &&
    receipt?.status === 'fenced' &&
    receipt.scope &&
    sameScope({ ...receipt.scope, baseUrl: intent.scope.baseUrl }, intent.scope)
  ) {
    return { kind: 'clear' } as const;
  }
  const status = confirmedSourceStatus(body, intent.scope);
  if (status) return { kind: 'authority', ...status } as const;
}

export function canCheckBlockedSource(record: SourceRecord, force: boolean): boolean {
  return (
    record.state === 'blocked' &&
    !record.installationRevoked &&
    !record.quarantineUncertain &&
    (force || record.lastFailureCode === 'http_403')
  );
}

export function serverRetryAt(header: string | null, now: number): number {
  if (!header) return 0;
  const time = /^\d+$/.test(header.trim()) ? now + Number(header) * 1000 : Date.parse(header);
  return Number.isFinite(time) && time > now ? Math.min(time, 253_402_300_799_000) : 0;
}

export function releaseRetry(status: number, attempts: number, header: string | null, now: number) {
  if (status !== 408 && status !== 429 && status < 500)
    return { blocked: true, nextAttemptAt: null, retryAfterAt: null };
  const delay = Math.floor(
    Math.min(60_000, 1000 * 2 ** Math.min(attempts, 6)) * (0.8 + Math.random() * 0.4),
  );
  const retryAt = serverRetryAt(header, now);
  return {
    blocked: false,
    nextAttemptAt: new Date(Math.max(now + delay, retryAt)).toISOString(),
    retryAfterAt: retryAt ? new Date(retryAt).toISOString() : null,
  };
}
