import type { ExactSource, SourceRecord, SourceScope } from './rivalhub-source-state.js';

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
