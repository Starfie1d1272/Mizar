import type { ObsCaptureDiagnostic } from '@mizar/protocol/obs';
import {
  collectObsNativeEvidence,
  type ObsNativeEvidence,
  type ObsNativeLogEvent,
} from './native-evidence.js';

function reason(event: ObsNativeLogEvent): ObsCaptureDiagnostic['reason'] {
  if (event.outcome === 'retry') return 'hook_pending';
  if (event.reason === 'hook_file_locked') return 'hook_file_locked';
  if (event.reason === 'process_open_failed')
    return event.code === 5 ? 'access_denied' : 'process_open_failed';
  return 'capture_failed';
}

/** Log health is independent from frame health; only a current, uniquely associated OBS session is eligible. */
export function projectObsCaptureDiagnostic(
  evidence: ObsNativeEvidence,
  now = Date.now(),
): ObsCaptureDiagnostic {
  const unknown: ObsCaptureDiagnostic = {
    state: 'unknown',
    reason: null,
    code: null,
    lastFailure: null,
    owner: 'unknown',
  };
  if (evidence.collectionStatus !== 'available') return unknown;
  const logs = evidence.roots
    .flatMap((root) => root.logs)
    .filter(
      (log) =>
        log.processAssociation === 'time_correlated' &&
        evidence.processes.some((p) => p.role === 'obs' && p.pid === log.processPid),
    );
  if (logs.length !== 1) return unknown;
  const log = logs[0]!;
  if (
    log.timestampStatus !== 'ordered' ||
    log.scan?.missingByteRange ||
    log.scan?.reasons.includes('oversized_lines') ||
    !log.latestCaptureEvent
  )
    return unknown;
  const event = log.latestCaptureEvent;
  const eventTime = event.occurredAt ? Date.parse(event.occurredAt) : NaN;
  if (!Number.isFinite(eventTime) || now - eventTime > 30000 || eventTime > now + 60000)
    return unknown;
  const lastFailure = log.latestCaptureFailure;
  if (event.outcome === 'success')
    return event.source === 'mizar_capture' ? { ...unknown, state: 'reported_success' } : unknown;
  if (event.outcome !== 'failure' && event.outcome !== 'retry') return unknown;
  return {
    state: 'needs_attention',
    reason: reason(event),
    code: event.code,
    owner: 'unknown',
    lastFailure: lastFailure ? { reason: reason(lastFailure), code: lastFailure.code } : null,
  };
}

/** Repeated polls share one bounded read. Cache expires; failed reads never replay an old alarm. */
export function createObsCaptureDiagnosticReader(
  collect = collectObsNativeEvidence,
  now = Date.now,
) {
  let pending: Promise<ObsCaptureDiagnostic> | null = null;
  let refreshPending: Promise<ObsCaptureDiagnostic> | null = null;
  let cached: ObsCaptureDiagnostic | null = null;
  let expires = 0;
  const read = (refresh = false): Promise<ObsCaptureDiagnostic> => {
    if (refresh) {
      // A manual recheck must read after any earlier poll, not consume its older snapshot.
      refreshPending ??= (pending ?? Promise.resolve())
        .then(() => {
          expires = 0;
          return read();
        })
        .finally(() => {
          refreshPending = null;
        });
      return refreshPending;
    }
    if (cached && now() < expires) return Promise.resolve(cached);
    pending ??= collect({ budgetMs: 3500 })
      .then((e) => projectObsCaptureDiagnostic(e, now()))
      .catch(
        () =>
          ({
            state: 'unknown',
            reason: null,
            code: null,
            lastFailure: null,
            owner: 'unknown',
          }) as const,
      )
      .then((value) => {
        cached = value;
        expires = now() + 5000;
        return value;
      })
      .finally(() => {
        pending = null;
      });
    return pending;
  };
  return read;
}
