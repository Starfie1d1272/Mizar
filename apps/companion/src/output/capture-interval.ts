import { reliableEventV1Schema, type ReliableEventV1 } from '@mizar/protocol/output';
import { z } from 'zod';
import type { ExactSource } from '../match-context/rivalhub-source-state.js';

const referenceSchema = z.strictObject({
  id: z.uuid(),
  storeId: z.uuid(),
  startCursor: reliableEventV1Schema.options[0].shape.cursor,
});
export type CaptureReference = z.infer<typeof referenceSchema>;
export function parseCaptureReference(value: unknown): CaptureReference {
  return referenceSchema.parse(value);
}
const ticketSchema = z.strictObject({
  activationCursor: reliableEventV1Schema.options[0].shape.cursor,
  requestId: z.string().min(1).max(128),
  intervalId: z.uuid(),
  sequence: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
});
export type CaptureTicket = z.infer<typeof ticketSchema>;
export function parseCaptureTicket(value: unknown): CaptureTicket {
  return ticketSchema.parse(value);
}
export interface CaptureInterval {
  readonly reference: CaptureReference;
  readonly source: ExactSource;
  readonly state: 'armed' | 'sealed' | 'unknown';
  readonly committedSequence: number;
  readonly activationCursor?: ReliableEventV1['cursor'];
  readonly endCursor?: ReliableEventV1['cursor'];
}
