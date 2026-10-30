import { randomUUID } from 'node:crypto';
import { open } from 'node:fs/promises';
import { z } from 'zod';
import {
  durableJsonByteLength,
  replaceDurableJson,
  type DurableJsonFaultInjector,
} from './durable-json.js';
import { SerialCommitQueue } from './serial-commit.js';

const MAX_RECORDS = 64;
const MAX_BYTES = 256 * 1024;
const identifier = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => value.trim() === value);
const baseUrl = z
  .string()
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        url.origin === value &&
        !url.username &&
        !url.password &&
        (url.protocol === 'https:' ||
          (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
      );
    } catch {
      return false;
    }
  });
const scopeSchema = z
  .object({
    baseUrl,
    competitionId: identifier,
    installationId: identifier,
    matchId: identifier,
    producerInstanceId: identifier,
    liveSessionId: identifier,
  })
  .strict();
const exactSchema = scopeSchema
  .extend({ authorityRevision: z.number().int().positive().safe() })
  .strict();
const causeSchema = z.enum(['finish', 'switch', 'shutdown', 'recovery', 'authority_check']);
const recordSchema = z
  .object({
    identity: exactSchema,
    state: z.enum(['owned', 'release_pending', 'blocked']),
    cause: causeSchema,
    attempts: z.number().int().nonnegative().safe(),
    nextAttemptAt: z.string().datetime().nullable(),
    retryAfterAt: z.string().datetime().nullable().optional(),
    lastFailureCode: z
      .string()
      .regex(/^[a-z0-9_]{1,64}$/)
      .nullable(),
  })
  .strict();
const intentSchema = z
  .object({
    id: z.string().uuid(),
    scope: scopeSchema,
    previousAuthorityRevision: z.number().int().positive().safe().nullable(),
  })
  .strict();
const envelopeSchema = z
  .object({
    version: z.literal(1),
    records: z.array(recordSchema).max(MAX_RECORDS),
    intent: intentSchema.nullable(),
    watermarks: z.array(exactSchema).max(MAX_RECORDS).default([]),
  })
  .strict()
  .superRefine((state, ctx) => {
    const keys = state.records.map((record) => exactKey(record.identity));
    if (
      new Set(keys).size !== keys.length ||
      state.records.filter((record) => record.state === 'owned').length > 1
    )
      ctx.addIssue({ code: 'custom', message: 'duplicate or multiple owned sources' });
  });

export type SourceScope = z.infer<typeof scopeSchema>;
export type ExactSource = z.infer<typeof exactSchema>;
export type SourceRecord = z.infer<typeof recordSchema>;
export type ClaimIntent = z.infer<typeof intentSchema>;
export type SourceState = z.infer<typeof envelopeSchema>;
export type SourceCause = z.infer<typeof causeSchema>;

function exactKey(identity: ExactSource): string {
  return JSON.stringify([
    identity.baseUrl,
    identity.competitionId,
    identity.installationId,
    identity.matchId,
    identity.producerInstanceId,
    identity.liveSessionId,
    identity.authorityRevision,
  ]);
}
function sameScope(a: SourceScope, b: SourceScope): boolean {
  return (
    a.baseUrl === b.baseUrl &&
    a.competitionId === b.competitionId &&
    a.installationId === b.installationId &&
    a.matchId === b.matchId &&
    a.producerInstanceId === b.producerInstanceId &&
    a.liveSessionId === b.liveSessionId
  );
}

/** Durable control identities only. The caller owns transport and operation serialization. */
export class RivalHubSourceState {
  private readonly queue = new SerialCommitQueue();
  private state: SourceState | undefined;
  constructor(
    private readonly path: string,
    private readonly faultInjector?: DurableJsonFaultInjector,
  ) {}

  async load(): Promise<SourceState> {
    return this.queue.run(async () => {
      if (this.state) return structuredClone(this.state);
      let bytes: Buffer;
      try {
        const file = await open(this.path, 'r');
        try {
          const stat = await file.stat();
          if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error('invalid source state size');
          bytes = await file.readFile();
          if (bytes.length > MAX_BYTES) throw new Error('invalid source state size');
        } finally {
          await file.close();
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        this.state = { version: 1, records: [], intent: null, watermarks: [] };
        return structuredClone(this.state);
      }
      this.state = envelopeSchema.parse(JSON.parse(bytes.toString('utf8')) as unknown);
      return structuredClone(this.state);
    });
  }

  private async change<T>(update: (state: SourceState) => T): Promise<T> {
    return this.queue.run(async () => {
      if (!this.state) throw new Error('source state not loaded');
      const next = structuredClone(this.state);
      const result = update(next);
      const validated = envelopeSchema.parse(next);
      if (durableJsonByteLength(validated) > MAX_BYTES)
        throw new Error('source state capacity exceeded');
      await replaceDurableJson(
        this.path,
        validated,
        this.faultInjector ? { faultInjector: this.faultInjector } : {},
      );
      this.state = validated;
      return structuredClone(result);
    });
  }

  async snapshot(): Promise<SourceState> {
    return this.queue.run(() => {
      if (!this.state) throw new Error('source state not loaded');
      return structuredClone(this.state);
    });
  }

  /** Persist before sending claim. A previous unknown claim must be resolved first. */
  async beginClaim(
    scope: SourceScope,
    previousAuthorityRevision: number | null,
  ): Promise<ClaimIntent> {
    return this.change((state) => {
      if (state.intent) throw new Error('source claim requires reconciliation');
      const validScope = scopeSchema.parse(scope);
      // Producer identities are newly generated per process. Old producer watermarks
      // cannot describe a new claim, while unresolved records remain untouched.
      state.watermarks = state.watermarks.filter(
        (item) => item.producerInstanceId === validScope.producerInstanceId,
      );
      const scopes = [...state.watermarks, ...state.records.map((record) => record.identity)];
      const scopeKeys = new Set(
        scopes.map((item) =>
          JSON.stringify([
            item.baseUrl,
            item.competitionId,
            item.installationId,
            item.matchId,
            item.producerInstanceId,
            item.liveSessionId,
          ]),
        ),
      );
      if (scopeKeys.size >= MAX_RECORDS && !scopes.some((item) => sameScope(item, validScope)))
        throw new Error('source state capacity exceeded');
      const owned = state.records.find((record) => record.state === 'owned');
      if (owned && !sameScope(owned.identity, validScope)) {
        owned.state = 'release_pending';
        owned.cause = 'switch';
      }
      // Reserve a slot before contacting the server; unresolved identities are never evicted.
      if (state.records.length >= MAX_RECORDS) throw new Error('source state capacity exceeded');
      const known = scopes
        .filter((item) => sameScope(item, validScope))
        .map((item) => item.authorityRevision);
      if (previousAuthorityRevision !== null) known.push(previousAuthorityRevision);
      const intent = intentSchema.parse({
        id: randomUUID(),
        scope: validScope,
        previousAuthorityRevision: known.length ? Math.max(...known) : null,
      });
      state.intent = intent;
      return intent;
    });
  }

  /** Persist the exact authority before the caller enables sends. */
  async confirmClaim(intentId: string, authorityRevision: number): Promise<ExactSource> {
    return this.change((state) => {
      const intent = state.intent;
      if (!intent || intent.id !== intentId) throw new Error('stale source claim');
      const identity = exactSchema.parse({ ...intent.scope, authorityRevision });
      const key = exactKey(identity);
      for (const record of state.records) {
        if (record.state === 'owned' && exactKey(record.identity) !== key) {
          record.state = 'release_pending';
          record.cause = 'switch';
        }
      }
      const existing = state.records.find((record) => exactKey(record.identity) === key);
      if (existing) {
        existing.state = 'owned';
        existing.cause = 'recovery';
        existing.attempts = 0;
        existing.nextAttemptAt = null;
        existing.retryAfterAt = null;
        existing.lastFailureCode = null;
      } else {
        if (state.records.length >= MAX_RECORDS) throw new Error('source state capacity exceeded');
        state.records.push({
          identity,
          state: 'owned',
          cause: 'recovery',
          attempts: 0,
          nextAttemptAt: null,
          lastFailureCode: null,
        });
      }
      state.intent = null;
      return identity;
    });
  }

  /** Only call after a conclusive response or exact status lookup proves no claim occurred. */
  async clearIntent(intentId: string): Promise<void> {
    await this.change((state) => {
      if (!state.intent || state.intent.id !== intentId) throw new Error('stale source claim');
      state.intent = null;
    });
  }

  async handoff(identity: ExactSource, cause: SourceCause): Promise<void> {
    await this.change((state) => {
      const record = state.records.find((item) => exactKey(item.identity) === exactKey(identity));
      if (!record) throw new Error('source identity not found');
      if (record.state === 'owned') {
        record.state = 'release_pending';
        record.cause = cause;
      }
    });
  }

  /** Recovery never restores permission to send from the previous process. */
  async recover(): Promise<void> {
    await this.change((state) => {
      for (const record of state.records)
        if (record.state === 'owned') {
          record.state = 'release_pending';
          record.cause = 'recovery';
        }
    });
  }

  async failure(
    identity: ExactSource,
    code: string,
    nextAttemptAt: string | null,
    blocked: boolean,
    retryAfterAt: string | null = null,
  ): Promise<void> {
    await this.change((state) => {
      const record = state.records.find((item) => exactKey(item.identity) === exactKey(identity));
      if (!record || record.state === 'owned') throw new Error('source is not pending');
      record.state = blocked ? 'blocked' : 'release_pending';
      record.attempts += 1;
      record.lastFailureCode = code;
      record.nextAttemptAt = nextAttemptAt;
      record.retryAfterAt = retryAfterAt;
    });
  }

  /** Remove only the exact record confirmed released or terminal by the server. */
  async complete(identity: ExactSource): Promise<void> {
    await this.change((state) => {
      const index = state.records.findIndex(
        (item) => exactKey(item.identity) === exactKey(identity),
      );
      if (index < 0 || state.records[index]?.state === 'owned')
        throw new Error('source is not pending');
      const watermark = state.watermarks.find((item) => sameScope(item, identity));
      if (watermark)
        watermark.authorityRevision = Math.max(
          watermark.authorityRevision,
          identity.authorityRevision,
        );
      else {
        if (state.watermarks.length >= MAX_RECORDS)
          throw new Error('source state capacity exceeded');
        state.watermarks.push(identity);
      }
      state.records.splice(index, 1);
    });
  }

  /** Explicit user disconnect succeeded: the server revoked this installation and its sources. */
  async completeRevokedInstallation(
    scope: Pick<SourceScope, 'baseUrl' | 'competitionId' | 'installationId'>,
  ): Promise<void> {
    await this.change((state) => {
      const matches = (value: SourceScope) =>
        value.baseUrl === scope.baseUrl &&
        value.competitionId === scope.competitionId &&
        value.installationId === scope.installationId;
      state.records = state.records.filter((record) => !matches(record.identity));
      state.watermarks = state.watermarks.filter((item) => !matches(item));
      if (state.intent && matches(state.intent.scope)) state.intent = null;
    });
  }
}
