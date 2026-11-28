import type { ReliableEventV2 } from '@mizar/protocol/output';

export const RELIABLE_SEND_TIMEOUT_MS = 5_000;

export type ReliableDeliveryResult =
  | {
      readonly status: 'accepted';
      readonly outcome?: 'needs_attention';
      readonly warning?: string;
    }
  | { readonly status: 'retry'; readonly error?: string }
  | { readonly status: 'rejected'; readonly error: string };

export interface ReliableEventSink {
  send(event: ReliableEventV2, signal?: AbortSignal): Promise<ReliableDeliveryResult>;
}
