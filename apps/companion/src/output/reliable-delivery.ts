import type { ReliableEventV1 } from '@mizar/protocol/output';
import type { ExactSource } from '../match-context/rivalhub-source-state.js';

export const RELIABLE_SEND_TIMEOUT_MS = 5_000;

export type ReliableRejectionReason =
  | 'context_stale'
  | 'sequence_stale'
  | 'generation_fence'
  | 'epoch_fence'
  | 'authority_changed'
  | 'idempotency_conflict'
  | 'invalid_schema';
export interface ReliableRejection {
  readonly status: 'rejected';
  readonly reason: ReliableRejectionReason;
  readonly requestId?: string;
  readonly recovery: 'refresh_context' | 'reconcile' | 'none';
}
export interface ReliableAttention {
  readonly status: 'accepted';
  readonly outcome: 'needs_attention';
}
export type ReliableDeliveryResult =
  'accepted' | 'rejected' | 'retry' | ReliableRejection | ReliableAttention;

export function parseReliableRejection(input: unknown): ReliableRejection | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const value = input as Record<string, unknown>;
  const recoveryByReason: Record<ReliableRejectionReason, ReliableRejection['recovery']> = {
    context_stale: 'refresh_context',
    sequence_stale: 'reconcile',
    generation_fence: 'reconcile',
    epoch_fence: 'reconcile',
    authority_changed: 'none',
    idempotency_conflict: 'none',
    invalid_schema: 'none',
  };
  if (
    typeof value.reason !== 'string' ||
    !Object.hasOwn(recoveryByReason, value.reason) ||
    (value.requestId !== undefined &&
      (typeof value.requestId !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          value.requestId,
        ))) ||
    value.recovery !== recoveryByReason[value.reason as ReliableRejectionReason]
  )
    return undefined;
  return {
    status: 'rejected',
    reason: value.reason as ReliableRejectionReason,
    ...(typeof value.requestId === 'string' ? { requestId: value.requestId } : {}),
    recovery: value.recovery as ReliableRejection['recovery'],
  };
}

export interface ReliableEventSink {
  send(
    event: ReliableEventV1,
    signal?: AbortSignal,
    lineupSteam64?: readonly string[],
    source?: ExactSource,
  ): Promise<ReliableDeliveryResult>;
}
