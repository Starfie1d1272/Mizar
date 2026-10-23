import { z } from 'zod';
import type { ProgramPayload, ProgramSnapshot } from '@mizar/protocol/program';
const entry = z
  .object({
    binding: z.string().min(1).max(256),
    id: z.string().min(1).max(96),
    sender: z.string().min(1).max(128),
    text: z.string().min(1).max(512),
    sourceAfterUtc: z.string().datetime(),
    capturedAt: z.string().datetime(),
  })
  .strict();

/** Public ALL text only; ephemeral presentation scoped to the accepted Program cursor. */
export class ProgramChat {
  private scope = '';
  private scopeAt = Date.now();
  private binding = '';
  private items: NonNullable<ProgramPayload['allChat']> = [];
  private seen = new Set<string>();
  ingest(record: { stage: string; [key: string]: unknown }) {
    if (record.stage !== 'program_all_chat' || typeof record.detail !== 'string') return;
    let parsed: ReturnType<typeof entry.safeParse>;
    try {
      parsed = entry.safeParse(JSON.parse(record.detail));
    } catch {
      return;
    }
    if (!parsed.success || !this.scope) return;
    const item = parsed.data;
    const captured = Date.parse(item.capturedAt),
      after = Date.parse(item.sourceAfterUtc),
      now = Date.now();
    if (after <= this.scopeAt || captured < after || captured > now + 1000 || now - captured > 5000)
      return;
    if (this.binding !== item.binding) {
      this.items = [];
      this.seen.clear();
      this.binding = item.binding;
    }
    if (this.seen.has(item.id)) return;
    this.seen.add(item.id);
    if (this.seen.size > 256) this.seen.delete(this.seen.values().next().value!);
    this.items = [
      ...this.items,
      {
        id: item.id,
        sender: item.sender,
        text: item.text,
        expiresAt: new Date(captured + 15000).toISOString(),
      },
    ].slice(-3);
  }
  view(cursor: ProgramSnapshot['cursor'], fresh: boolean): NonNullable<ProgramPayload['allChat']> {
    const scope = JSON.stringify([
      cursor.producerInstanceId,
      cursor.liveSessionId,
      cursor.programSourceGeneration,
      cursor.mapEpoch,
    ]);
    if (!fresh || scope !== this.scope) {
      this.scope = fresh ? scope : '';
      this.scopeAt = Date.now();
      this.items = [];
      this.seen.clear();
    }
    this.items = this.items.filter((item) => Date.parse(item.expiresAt) > Date.now());
    return this.items.map((item) => ({ ...item }));
  }
}
