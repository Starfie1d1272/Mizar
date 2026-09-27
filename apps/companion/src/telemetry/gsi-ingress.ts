import { timingSafeEqual } from 'node:crypto';
import { performance } from 'node:perf_hooks';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { TelemetryObservation } from '@mizar/core/telemetry';
import {
  adaptGsiPayload,
  PRODUCTION_GSI_CONFIG,
  type GsiAdaptResult,
  type GsiDiagnosticBatch,
  type TelemetryReceiveContext,
} from '@mizar/telemetry-gsi';

import { resolveCaptureRecorder, type CaptureRecorderSource } from './capture-recorder.js';

export const GSI_BODY_LIMIT_BYTES = 64 * 1024;
export const GSI_REQUEST_TIMEOUT_MS = 5_000;

export { PRODUCTION_GSI_CONFIG };

export interface GsiClockSample {
  readonly receivedAt: string;
  readonly receivedMonotonicMs: number;
}

export interface GsiClock {
  now(): GsiClockSample;
}

/** Synchronous local handoff only; the callback must not perform I/O or return a Promise. */
export type ObservationSink = (observation: TelemetryObservation) => void;
/** Synchronous local handoff only; the callback must not perform I/O or return a Promise. */
export type GsiDiagnosticsSink = (diagnostics: GsiDiagnosticBatch) => void;
/** Synchronous local handoff of the accepted, shallow-auth-sanitized source payload. */
export interface AcceptedRawInput {
  readonly sequence: number;
  readonly receivedAt: string;
  readonly receivedMonotonicMs: number;
  readonly payload: Record<string, unknown>;
}
/** Synchronous local handoff only; the callback must not perform I/O or return a Promise. */
export type AcceptedRawSink = (input: AcceptedRawInput) => void;
/** Deterministic receive-sequence seam for integration fault injection; omit in production. */
export type GsiSequenceSource = () => number;

export type CompanionRuntimeDiagnosticCode =
  | 'adapter_unexpected_failure'
  | 'accepted_raw_sink_failed'
  | 'gsi_diagnostics_sink_failed'
  | 'observation_sink_failed'
  | 'recorder_unexpected_failure';

export interface GsiIngressOptions {
  readonly gsiToken: string;
  readonly recorder: CaptureRecorderSource;
  readonly sequenceSource?: GsiSequenceSource;
  readonly onAcceptedRaw?: AcceptedRawSink;
  readonly onObservation?: ObservationSink;
  readonly onGsiDiagnostics?: GsiDiagnosticsSink;
  readonly clock?: GsiClock;
  readonly onRuntimeDiagnostic?: (code: CompanionRuntimeDiagnosticCode) => void;
}

const defaultClock: GsiClock = {
  now: () => ({
    receivedAt: new Date().toISOString(),
    receivedMonotonicMs: performance.now(),
  }),
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasMatchingToken(value: unknown, expected: string): boolean {
  if (!isRecord(value) || typeof value.token !== 'string') return false;
  const actualBytes = Buffer.from(value.token, 'utf8');
  const expectedBytes = Buffer.from(expected, 'utf8');
  if (actualBytes.length !== expectedBytes.length) return false;
  return timingSafeEqual(actualBytes, expectedBytes);
}

function withoutAuth(payload: Record<string, unknown>): Record<string, unknown> {
  const sanitized = { ...payload };
  delete sanitized.auth;
  return sanitized;
}

function isSupportedContentType(value: string | string[] | undefined): boolean {
  if (value === undefined) return true;
  const contentType = Array.isArray(value) ? value[0] : value;
  return contentType !== undefined && /^application\/json(?:\s*;|$)/i.test(contentType);
}

function sendNoContent(reply: FastifyReply): void {
  void reply.code(204).send();
}

function reportRuntimeDiagnostic(
  options: GsiIngressOptions,
  code: CompanionRuntimeDiagnosticCode,
): void {
  try {
    options.onRuntimeDiagnostic?.(code);
  } catch {
    // Diagnostics must never affect the accepted frame response.
  }
}

export function registerGsiIngress(app: FastifyInstance, options: GsiIngressOptions): void {
  if (options.gsiToken.trim().length === 0) {
    throw new Error('gsiToken must be a non-empty value');
  }

  const clock = options.clock ?? defaultClock;
  let sequence = 0;
  const nextSequence = options.sequenceSource ?? (() => sequence++);

  app.post(
    '/gsi',
    { bodyLimit: GSI_BODY_LIMIT_BYTES },
    (request: FastifyRequest<{ Body: unknown }>, reply: FastifyReply) => {
      if (!isSupportedContentType(request.headers['content-type'])) {
        void reply.code(415).send();
        return;
      }

      const root = request.body;
      if (!isRecord(root)) {
        void reply.code(400).send();
        return;
      }

      if (!hasMatchingToken(root.auth, options.gsiToken)) {
        void reply.code(401).send();
        return;
      }

      const receive = clock.now();
      const acceptedSequence = nextSequence();
      const payload = withoutAuth(root);
      const receiveContext: TelemetryReceiveContext = {
        sequence: acceptedSequence,
        receivedAt: receive.receivedAt,
        receivedMonotonicMs: receive.receivedMonotonicMs,
      };

      try {
        resolveCaptureRecorder(options.recorder).tryRecord({
          sequence: acceptedSequence,
          receivedAt: receive.receivedAt,
          receivedMonotonicMs: receive.receivedMonotonicMs,
          payload,
        });
      } catch {
        reportRuntimeDiagnostic(options, 'recorder_unexpected_failure');
      }

      try {
        options.onAcceptedRaw?.({
          sequence: acceptedSequence,
          receivedAt: receive.receivedAt,
          receivedMonotonicMs: receive.receivedMonotonicMs,
          payload,
        });
      } catch {
        reportRuntimeDiagnostic(options, 'accepted_raw_sink_failed');
      }

      let adapted: GsiAdaptResult;
      try {
        adapted = adaptGsiPayload(payload, receiveContext);
      } catch {
        reportRuntimeDiagnostic(options, 'adapter_unexpected_failure');
        sendNoContent(reply);
        return;
      }

      try {
        options.onGsiDiagnostics?.(adapted.diagnostics);
      } catch {
        reportRuntimeDiagnostic(options, 'gsi_diagnostics_sink_failed');
      }

      if (!adapted.ok) {
        sendNoContent(reply);
        return;
      }

      try {
        options.onObservation?.(adapted.observation);
      } catch {
        reportRuntimeDiagnostic(options, 'observation_sink_failed');
      }

      sendNoContent(reply);
    },
  );
}
