import { createHash } from 'node:crypto';
import type { ReliableEventV1 } from '@mizar/protocol/output';
import type { ExactSource } from '../match-context/rivalhub-source-state.js';
import {
  isContinuityBoundary,
  parseOutbox,
  parseSource,
  sealOutbox,
  type BoundaryIntent,
  type BoundaryScope,
  type DeliveryContinuity,
} from './outbox-codec.js';

/** The original mutation, not a reconstruction from the latest projection. */
export interface BoundaryCapture {
  readonly events: readonly ReliableEventV1[];
  readonly intents: readonly BoundaryIntent[];
  readonly continuity?: DeliveryContinuity;
  readonly missing: boolean;
  readonly at: string;
  readonly scope?: BoundaryScope;
  readonly source?: ExactSource | null;
  readonly reference?: ReliableEventV1;
}

export interface BoundaryCaptureOperation {
  readonly id: string;
  readonly request: BoundaryCapture;
}

export function parseBoundaryCapture(input: unknown): BoundaryCaptureOperation {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('boundary_capture_invalid');
  const value = input as BoundaryCapture;
  if (
    Object.keys(value).some(
      (key) =>
        ![
          'events',
          'intents',
          'continuity',
          'missing',
          'at',
          'scope',
          'source',
          'reference',
        ].includes(key),
    ) ||
    !Array.isArray(value.events) ||
    !Array.isArray(value.intents) ||
    typeof value.missing !== 'boolean' ||
    typeof value.at !== 'string' ||
    !Number.isFinite(Date.parse(value.at))
  )
    throw new Error('boundary_capture_invalid');
  const source = value.source == null ? value.source : parseSource(value.source);
  // Reuse the durable queue's validators for events, source, scope and checkpoint.
  const file = parseOutbox(
    Buffer.from(
      JSON.stringify(
        sealOutbox({
          version: 'mizar.reliable-outbox.v2',
          records: value.events.map((event) => ({
            event,
            ...(source ? { source } : {}),
            ...(source === null ? { awaitingSource: true as const } : {}),
            status: 'pending' as const,
            attempts: 0,
            nextAttemptAt: value.at,
            updatedAt: value.at,
          })),
          boundaryIntents: value.intents.map((intent) => ({
            event: intent.event,
            planFingerprint: intent.planFingerprint,
            authorityFingerprint: intent.authorityFingerprint,
            ...(intent.expired ? { expired: true as const } : {}),
            ...(source ? { source } : {}),
            ...(source === null ? { awaitingSource: true as const } : {}),
          })),
          ...(value.scope ? { boundaryGaps: [value.scope] } : {}),
          ...(value.continuity ? { continuity: value.continuity } : {}),
          ...(value.reference ? { continuityReference: value.reference } : {}),
        }),
      ),
    ),
  );
  if (file.records.some((record) => !isContinuityBoundary(record.event)))
    throw new Error('boundary_capture_invalid');
  const request: BoundaryCapture = {
    events: file.records.map((record) => record.event),
    intents: file.boundaryIntents ?? [],
    ...(file.continuity ? { continuity: file.continuity } : {}),
    missing: value.missing,
    at: value.at,
    ...(file.boundaryGaps?.[0] ? { scope: file.boundaryGaps[0] } : {}),
    ...(source === undefined ? {} : { source }),
    // Only needed to validate an empty capture's checkpoint after a restart.
    ...(file.continuity &&
    !file.records.length &&
    !file.boundaryIntents?.length &&
    file.continuityReference
      ? { reference: file.continuityReference }
      : {}),
  };
  return { id: createHash('sha256').update(JSON.stringify(request)).digest('hex'), request };
}

export class BoundaryCaptureError extends Error {
  constructor(
    readonly operationId: string,
    readonly stage: 'journal' | 'preflight' | 'commit' | 'verify',
    readonly request: BoundaryCapture,
    cause: unknown,
  ) {
    super('outbox_boundary_capture_failed', { cause });
    this.name = 'BoundaryCaptureError';
  }
}
