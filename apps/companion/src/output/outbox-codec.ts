import type { ReliableEventV2 } from '@mizar/protocol/output';

export const RELIABLE_OUTBOX_RETENTION_MS = 24 * 60 * 60 * 1000;
export type ReliableDeliveryStatus = 'pending' | 'accepted' | 'rejected' | 'expired';

export interface ReliableOutboxRecord {
  readonly event: ReliableEventV2;
  readonly status: ReliableDeliveryStatus;
  readonly attempts: number;
  readonly nextAttemptAt: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastError: string | null;
}
