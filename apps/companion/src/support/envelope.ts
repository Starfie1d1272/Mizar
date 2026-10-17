import { businessEvidenceHasFailure } from './business-evidence.js';
import { z } from 'zod';

export type DiagnosticFailureKind =
  | 'operation'
  | 'browser'
  | 'native'
  | 'performance'
  | 'telemetry'
  | 'service'
  | 'diagnostic_io'
  | 'transport'
  | 'business'
  | 'update'
  | 'unattributed';
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const array = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const iso = z.iso.datetime({ offset: true });
export function diagnosticSourceUtc(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0 && value < 1e14)
    return new Date(value).toISOString();
  return typeof value === 'string' &&
    iso.safeParse(value).success &&
    Number.isFinite(Date.parse(value))
    ? new Date(value).toISOString()
    : null;
}
const errorPresent = (value: unknown) =>
  value !== null && value !== undefined && value !== false && value !== '';
const failed = (value: unknown) =>
  ['failure', 'failed', 'blocked', 'unconfirmed', 'rejected'].includes(value as string);
const cancelled = (value: unknown) => value === 'cancelled';
const directStages: Record<string, DiagnosticFailureKind> = {
  request_error: 'operation',
  observation_failure: 'telemetry',
  telemetry_failure: 'telemetry',
  diagnostic_transport_failure: 'transport',
  diagnostic_cloud_expired: 'transport',
  native_source_gap: 'diagnostic_io',
  diagnostic_delivery_failure: 'diagnostic_io',
  native_source_failure: 'diagnostic_io',
  website_original_error: 'business',
};
/** Parse the authorized producer envelopes once, after cloud consent filtering.
 * Indexes count records containing failure evidence, not independent incidents or root causes.
 * Known deferred producers never substitute collection time for an unavailable source clock. */
export function diagnosticEnvelope(value: unknown): {
  times: string[];
  failureKinds: DiagnosticFailureKind[];
  sourceTimeUnknown: boolean;
} {
  const event = object(value);
  const evidence = object(event.evidence);
  const kinds = new Set<DiagnosticFailureKind>();
  const stamps: unknown[] = [];
  const stage = typeof event.stage === 'string' ? event.stage : '';
  if (directStages[stage]) kinds.add(directStages[stage]);
  if (stage === 'native_host_records') {
    const entries = array(evidence.entries);
    for (const item of entries) {
      const entry = object(object(item).entry);
      stamps.push(entry.time);
      if (failed(entry.result) || errorPresent(entry.error)) kinds.add('native');
    }
    // An empty consent-filtered group is current exclusion metadata, not an old Host operation.
    if (!entries.length) stamps.push(event.time);
  } else if (stage === 'browser_control') {
    stamps.push(evidence.time);
    const detail = object(evidence.evidence);
    if (evidence.operation === 'browser_performance')
      stamps.push(...array(detail.anomalies).map((item) => object(item).time));
    const terminal = evidence.operation === 'task' ? object(detail.evidence) : detail;
    if (!cancelled(terminal.result)) {
      if (
        evidence.operation === 'browser_error' ||
        evidence.operation === 'browser_unhandled_rejection'
      )
        kinds.add('browser');
      else if (
        evidence.phase === 'failure' ||
        failed(terminal.result) ||
        errorPresent(terminal.error)
      )
        kinds.add('operation');
      if (
        evidence.operation === 'browser_performance' &&
        typeof detail.anomalyCount === 'number' &&
        detail.anomalyCount > 0
      )
        kinds.add('performance');
    }
  } else if (
    [
      'performance_anomaly_begin',
      'performance_anomaly_trigger',
      'performance_anomaly_samples',
      'performance_anomaly_end',
    ].includes(stage)
  ) {
    const source = object(evidence.sourceRecord);
    const correlation = object(evidence.correlation);
    stamps.push(
      source.time,
      evidence.time,
      correlation.observedAt,
      ...array(evidence.samples).map((sample) => object(sample).time),
    );
    if (evidence.reason === 'observation_failure' || evidence.reason === 'telemetry_diagnostic')
      kinds.add('telemetry');
    if (evidence.reason === 'slow_observation' || errorPresent(correlation.error))
      kinds.add('performance');
    if (
      !correlation.sourceEvidenceExcluded &&
      (correlation.operation === 'browser_error' ||
        correlation.operation === 'browser_unhandled_rejection')
    )
      kinds.add('browser');
    const original = object(correlation.originalEvidence);
    if (correlation.operation === 'browser_performance')
      stamps.push(...array(original.anomalies).map((item) => object(item).time));
    if (errorPresent(original.error)) kinds.add('browser');
    if (
      correlation.operation === 'browser_performance' &&
      typeof original.anomalyCount === 'number' &&
      original.anomalyCount > 0
    )
      kinds.add('performance');
  } else if (stage === 'service_log') {
    stamps.push(evidence.time ?? event.time);
    if (
      (typeof evidence.level === 'number' && evidence.level >= 50) ||
      failed(evidence.result) ||
      errorPresent(evidence.err) ||
      errorPresent(evidence.error) ||
      errorPresent(object(evidence.diagnostic).error)
    )
      kinds.add('service');
  } else if (stage === 'update_stage') {
    stamps.push(evidence.time);
    const diagnostic = object(evidence.diagnostic);
    if (failed(diagnostic.result) || errorPresent(diagnostic.error)) kinds.add('update');
  } else if (stage === 'business_evidence') {
    stamps.push(evidence.recordedAt);
    if (businessEvidenceHasFailure(evidence.evidence)) kinds.add('business');
  } else {
    stamps.push(event.time);
    if (
      stage === 'operation_result' &&
      typeof evidence.httpStatus === 'number' &&
      evidence.httpStatus >= 400
    )
      kinds.add('operation');
    if (!cancelled(evidence.result)) {
      if (failed(evidence.result) || evidence.phase === 'failure') kinds.add('operation');
      if (errorPresent(evidence.error) && !kinds.size) kinds.add('unattributed');
    }
  }
  const times = [
    ...new Set(stamps.map(diagnosticSourceUtc).filter((time): time is string => time !== null)),
  ].sort();
  return { times, failureKinds: [...kinds].sort(), sourceTimeUnknown: times.length === 0 };
}
