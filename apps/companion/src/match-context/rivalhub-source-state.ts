import { createHash, randomUUID } from 'node:crypto';
import { open, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
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
    state: z.enum(['owned', 'release_pending', 'blocked', 'archive_pending']),
    installationRevoked: z.literal(true).optional(),
    quarantineUncertain: z.literal(true).optional(),
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
    quarantineUncertain: z.literal(true).optional(),
    // Proof that this intent re-claimed an exact authority already held before
    // the request. Older durable files may not have this field.
    idempotentAuthorityRevision: z.number().int().positive().safe().optional(),
  })
  .strict();
const quarantineSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('source'), record: recordSchema }).strict(),
  z.object({ kind: z.literal('intent'), intent: intentSchema }).strict(),
  z.object({ kind: z.literal('watermark'), identity: exactSchema }).strict(),
]);
const envelopeSchema = z
  .object({
    version: z.literal(1),
    records: z.array(recordSchema).max(MAX_RECORDS),
    intent: intentSchema.nullable(),
    revokedIntents: z.array(intentSchema).max(MAX_RECORDS).default([]),
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
type QuarantineEvidence = z.infer<typeof quarantineSchema>;

function scopeKey(scope: SourceScope): string {
  return JSON.stringify([
    scope.baseUrl,
    scope.competitionId,
    scope.installationId,
    scope.matchId,
    scope.producerInstanceId,
    scope.liveSessionId,
  ]);
}
function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

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
  private revokedScanCursor = 0;
  constructor(
    private readonly path: string,
    private readonly faultInjector?: DurableJsonFaultInjector,
  ) {}

  private async quarantineNames(): Promise<string[]> {
    try {
      return (await readdir(`${this.path}.revoked`)).filter((name) =>
        /^[a-f0-9]{64}-[siw]-[a-f0-9]{64}-[a-f0-9]{64}\.json$/.test(name),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  private async readQuarantine(name: string): Promise<QuarantineEvidence> {
    const bytes = await readFile(join(`${this.path}.revoked`, name));
    if (bytes.length > MAX_BYTES) throw new Error('revoked evidence too large');
    const evidence = quarantineSchema.parse(JSON.parse(bytes.toString('utf8')) as unknown);
    const scope =
      evidence.kind === 'source'
        ? evidence.record.identity
        : evidence.kind === 'intent'
          ? evidence.intent.scope
          : evidence.identity;
    const itemKey =
      evidence.kind === 'source'
        ? `source:${exactKey(evidence.record.identity)}`
        : evidence.kind === 'intent'
          ? `intent:${evidence.intent.id}`
          : `watermark:${exactKey(evidence.identity)}`;
    if (
      name !==
      `${digest(scopeKey(scope))}-${evidence.kind[0]}-${digest(itemKey)}-${digest(JSON.stringify(evidence))}.json`
    )
      throw new Error('revoked evidence invalid');
    return evidence;
  }

  private async quarantine(evidence: QuarantineEvidence): Promise<void> {
    const valid = quarantineSchema.parse(evidence);
    const scope =
      valid.kind === 'source'
        ? valid.record.identity
        : valid.kind === 'intent'
          ? valid.intent.scope
          : valid.identity;
    const itemKey =
      valid.kind === 'source'
        ? `source:${exactKey(valid.record.identity)}`
        : valid.kind === 'intent'
          ? `intent:${valid.intent.id}`
          : `watermark:${exactKey(valid.identity)}`;
    const name = `${digest(scopeKey(scope))}-${valid.kind[0]}-${digest(itemKey)}-${digest(JSON.stringify(valid))}.json`;
    try {
      const existing = await this.readQuarantine(name);
      if (JSON.stringify(existing) !== JSON.stringify(valid))
        throw new Error('revoked evidence conflict');
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await replaceDurableJson(join(`${this.path}.revoked`, name), valid);
  }

  private async evidenceForScope(scope: SourceScope): Promise<QuarantineEvidence[]> {
    const prefix = `${digest(scopeKey(scope))}-`;
    const names = (await this.quarantineNames()).filter((name) => name.startsWith(prefix));
    return Promise.all(names.map((name) => this.readQuarantine(name)));
  }

  /** Retained unknown sources/claims never count toward the active source limit. */
  async quarantineCount(): Promise<number> {
    const names = await this.quarantineNames();
    return new Set(names.filter((name) => name[65] !== 'w').map((name) => name.slice(0, 131))).size;
  }

  async hasQuarantinedSource(identity: ExactSource): Promise<boolean> {
    return (await this.evidenceForScope(identity)).some(
      (evidence) =>
        (evidence.kind === 'source' && exactKey(evidence.record.identity) === exactKey(identity)) ||
        (evidence.kind === 'watermark' &&
          evidence.identity.authorityRevision >= identity.authorityRevision),
    );
  }

  async getQuarantined(scope: SourceScope): Promise<readonly QuarantineEvidence[]> {
    return this.evidenceForScope(scopeSchema.parse(scope));
  }

  /** Durable revocation evidence is also the retry queue for the output owner. */
  async getRevokedSources(
    excluded: readonly ExactSource[] = [],
    limit = 8,
    priority: readonly ExactSource[] = [],
  ): Promise<readonly ExactSource[]> {
    const result = new Map<string, ExactSource>();
    const excludedKeys = new Set(excluded.map(exactKey));
    const excludedTokens = new Set(
      excluded.map((identity) => digest(`source:${exactKey(identity)}`)),
    );
    const state = await this.snapshot();
    for (const record of state.records) {
      const key = exactKey(record.identity);
      if (
        record.installationRevoked &&
        record.state === 'archive_pending' &&
        !excludedKeys.has(key)
      )
        result.set(key, record.identity);
      if (result.size >= limit) return [...result.values()];
    }
    const names = (await this.quarantineNames()).filter(
      (name) => name[65] === 's' && !excludedTokens.has(name.slice(67, 131)),
    );
    const priorityTokens = new Set(
      priority.map((identity) => digest(`source:${exactKey(identity)}`)),
    );
    const prioritized = names.filter((name) => priorityTokens.has(name.slice(67, 131)));
    const other = names.filter((name) => !priorityTokens.has(name.slice(67, 131)));
    const rotating = prioritized.length ? prioritized : other;
    const start = rotating.length ? this.revokedScanCursor % rotating.length : 0;
    const ordered = [
      ...rotating.slice(start),
      ...rotating.slice(0, start),
      ...(prioritized.length ? other : []),
    ];
    let examined = 0;
    while (examined < Math.min(ordered.length, 32) && result.size < limit) {
      const name = ordered[examined]!;
      examined++;
      try {
        const item = await this.readQuarantine(name);
        if (item.kind === 'source' && item.record.installationRevoked)
          result.set(exactKey(item.record.identity), item.record.identity);
      } catch {
        // The unreadable scope remains blocked; other source jobs can continue.
      }
    }
    this.revokedScanCursor = rotating.length ? (start + examined) % rotating.length : 0;
    return [...result.values()];
  }

  /** Complete a previously interrupted file-first transfer before permitting new work. */
  private async reconcileQuarantine(state: SourceState): Promise<boolean> {
    let changed = false;
    const records: SourceRecord[] = [];
    for (const record of state.records) {
      if (record.state === 'archive_pending') {
        records.push(record);
        continue;
      }
      let evidence: QuarantineEvidence[];
      try {
        evidence = await this.evidenceForScope(record.identity);
      } catch {
        // Preserve both the unreadable file and the active record; isolate only
        // this scope without interpreting the damaged file as a release.
        await this.quarantine({
          kind: 'source',
          record: { ...record, state: 'blocked', quarantineUncertain: true },
        });
        changed = true;
        continue;
      }
      if (
        !evidence.some(
          (item) =>
            item.kind === 'source' && exactKey(item.record.identity) === exactKey(record.identity),
        )
      ) {
        records.push(record);
        continue;
      }
      await this.quarantine({
        kind: 'source',
        record: {
          ...record,
          state: 'blocked',
          installationRevoked: true,
          nextAttemptAt: null,
          retryAfterAt: null,
          lastFailureCode: record.lastFailureCode ?? 'installation_revoked',
        },
      });
      changed = true;
    }
    state.records = records;
    const watermarks: ExactSource[] = [];
    for (const identity of state.watermarks) {
      try {
        const evidence = await this.evidenceForScope(identity);
        if (
          evidence.some(
            (item) => item.kind === 'watermark' && exactKey(item.identity) === exactKey(identity),
          )
        ) {
          changed = true;
          continue;
        }
      } catch {
        // Keep the active confirmation when its separate evidence is unreadable.
      }
      watermarks.push(identity);
    }
    state.watermarks = watermarks;
    if (state.intent) {
      let evidence: QuarantineEvidence[];
      try {
        evidence = await this.evidenceForScope(state.intent.scope);
      } catch {
        await this.quarantine({
          kind: 'intent',
          intent: { ...state.intent, quarantineUncertain: true },
        });
        state.intent = null;
        changed = true;
        evidence = [];
      }
      if (
        state.intent &&
        evidence.some((item) => item.kind === 'intent' && item.intent.id === state.intent?.id)
      ) {
        await this.quarantine({ kind: 'intent', intent: state.intent });
        state.intent = null;
        changed = true;
      }
    }
    for (const intent of state.revokedIntents) {
      try {
        await this.quarantine({ kind: 'intent', intent });
      } catch {
        await this.quarantine({ kind: 'intent', intent: { ...intent, quarantineUncertain: true } });
      }
      changed = true;
    }
    state.revokedIntents = [];
    return changed;
  }

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
        this.state = { version: 1, records: [], intent: null, revokedIntents: [], watermarks: [] };
        return structuredClone(this.state);
      }
      const loaded = envelopeSchema.parse(JSON.parse(bytes.toString('utf8')) as unknown);
      if (await this.reconcileQuarantine(loaded)) {
        const validated = envelopeSchema.parse(loaded);
        if (durableJsonByteLength(validated) > MAX_BYTES)
          throw new Error('source state capacity exceeded');
        await replaceDurableJson(
          this.path,
          validated,
          this.faultInjector ? { faultInjector: this.faultInjector } : {},
        );
      }
      this.state = loaded;
      return structuredClone(this.state);
    });
  }

  private async change<T>(update: (state: SourceState) => T | Promise<T>): Promise<T> {
    return this.queue.run(async () => {
      if (!this.state) throw new Error('source state not loaded');
      const next = structuredClone(this.state);
      const result = await update(next);
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
    return this.change(async (state) => {
      await this.reconcileQuarantine(state);
      if (state.intent) throw new Error('source claim requires reconciliation');
      const validScope = scopeSchema.parse(scope);
      const quarantined = await this.evidenceForScope(validScope);
      if (quarantined.some((item) => item.kind !== 'watermark'))
        throw new Error('source requires cleanup before claim');
      if (
        state.records.some(
          (record) => sameScope(record.identity, validScope) && record.state !== 'owned',
        )
      )
        throw new Error('source requires cleanup before claim');
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
      known.push(
        ...quarantined.flatMap((item) =>
          item.kind === 'watermark' ? [item.identity.authorityRevision] : [],
        ),
      );
      if (previousAuthorityRevision !== null) known.push(previousAuthorityRevision);
      const intent = intentSchema.parse({
        id: randomUUID(),
        scope: validScope,
        previousAuthorityRevision: known.length ? Math.max(...known) : null,
        ...(owned &&
        sameScope(owned.identity, validScope) &&
        Math.max(...known) === owned.identity.authorityRevision &&
        !state.watermarks.some(
          (item) =>
            sameScope(item, validScope) &&
            item.authorityRevision >= owned.identity.authorityRevision,
        ) &&
        !quarantined.some(
          (item) =>
            item.kind === 'watermark' &&
            item.identity.authorityRevision >= owned.identity.authorityRevision,
        )
          ? { idempotentAuthorityRevision: owned.identity.authorityRevision }
          : {}),
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
        delete existing.installationRevoked;
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
      if (!record || record.state === 'owned' || record.state === 'archive_pending')
        throw new Error('source is not pending');
      record.state = blocked ? 'blocked' : 'release_pending';
      record.attempts += 1;
      record.lastFailureCode = code;
      record.nextAttemptAt = nextAttemptAt;
      record.retryAfterAt = retryAfterAt;
    });
  }

  /** Persist an exact remote release/closed confirmation before local archiving. */
  async confirmReleased(identity: ExactSource): Promise<void> {
    await this.change((state) => {
      const record = state.records.find((item) => exactKey(item.identity) === exactKey(identity));
      if (!record || record.state === 'owned') throw new Error('source is not pending');
      record.state = 'archive_pending';
      record.nextAttemptAt = null;
      record.retryAfterAt = null;
    });
  }

  /** Remove only the exact record confirmed released or terminal by the server. */
  async complete(identity: ExactSource): Promise<void> {
    await this.change(async (state) => {
      const index = state.records.findIndex(
        (item) => exactKey(item.identity) === exactKey(identity),
      );
      if (index < 0 || state.records[index]?.state !== 'archive_pending')
        throw new Error('source is not archive pending');
      // Upgrade legacy in-flight intents before removing their only durable
      // proof that the equal revision was held when the claim began.
      if (
        state.intent &&
        state.intent.idempotentAuthorityRevision === undefined &&
        sameScope(state.intent.scope, identity) &&
        state.intent.previousAuthorityRevision === identity.authorityRevision &&
        !state.watermarks.some(
          (item) =>
            sameScope(item, identity) && item.authorityRevision >= identity.authorityRevision,
        )
      )
        state.intent.idempotentAuthorityRevision = identity.authorityRevision;
      if (state.records[index]?.installationRevoked) {
        await this.quarantine({ kind: 'watermark', identity });
      } else {
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
      }
      state.records.splice(index, 1);
    });
  }

  /** Revocation is not an exact per-source release confirmation. */
  async confirmRevokedInstallation(
    scope: Pick<SourceScope, 'baseUrl' | 'competitionId' | 'installationId'>,
  ): Promise<readonly ExactSource[]> {
    return this.change(async (state) => {
      const matches = (value: SourceScope) =>
        value.baseUrl === scope.baseUrl &&
        value.competitionId === scope.competitionId &&
        value.installationId === scope.installationId;
      const remaining: SourceRecord[] = [];
      const revoked: ExactSource[] = [];
      for (const record of state.records) {
        if (!matches(record.identity)) {
          remaining.push(record);
          continue;
        }
        revoked.push(record.identity);
        if (record.state === 'archive_pending') {
          remaining.push({ ...record, installationRevoked: true });
          continue;
        }
        await this.quarantine({
          kind: 'source',
          record: {
            ...record,
            state: 'blocked',
            installationRevoked: true,
            nextAttemptAt: null,
            retryAfterAt: null,
            lastFailureCode: record.lastFailureCode ?? 'installation_revoked',
          },
        });
      }
      state.records = remaining;
      const watermarks: ExactSource[] = [];
      for (const identity of state.watermarks) {
        if (matches(identity)) await this.quarantine({ kind: 'watermark', identity });
        else watermarks.push(identity);
      }
      state.watermarks = watermarks;
      if (state.intent && matches(state.intent.scope)) {
        await this.quarantine({ kind: 'intent', intent: state.intent });
        state.intent = null;
      }
      return revoked;
    });
  }
}
