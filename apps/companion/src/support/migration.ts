import { ProducerRetention } from './retention.js';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { gunzip } from 'node:zlib';
import { promisify } from 'node:util';
import { atomicJson, safePath, syncDirectory } from '../resource-store/files.js';
import { diagnosticValue, type SessionJournal } from './session-journal.js';

const inflate = promisify(gunzip);
const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const legacyName =
  /^(?:session\.ndjson(?:\.\d+)?|desktop(?:\.\d+)?\.ndjson|desktop\.ndjson\.\d+|business\.ndjson(?:\.\d+)?|business-history\.json|supervisor\.ndjson(?:\.\d+)?|companion(?:\.stderr)?\.log(?:\.\d+)?|diagnostic-outbox\/[a-f0-9]{64}\.gz|performance-pending\/[a-f0-9-]{36}\.[a-f0-9]{4}\.json|marked-incidents\/[a-f0-9-]{36}\.json)$/;
const outputName =
  /^(?:migrated-[a-f0-9-]{36}\.ndjson|diagnostic-migration\/aliases-[a-f0-9-]{36}\.ndjson)$/;
const LIMIT = {
  sourceBytes: 32 * 1024 * 1024,
  lineBytes: 2 * 1024 * 1024,
  jsonBytes: 8 * 1024 * 1024,
  segmentBytes: 1024 * 1024,
  inventoryBytes: 8 * 1024 * 1024,
  stagingBytes: 256 * 1024 * 1024,
  identities: 262144,
  sources: 8192,
};
export interface MigrationFileReceipt {
  name: string;
  bytes: number;
  sha256: string;
  records: number;
}
export interface MigrationSource {
  key: string;
  name: string;
  sha256: string | null;
  bytes: number | null;
  status: 'pending' | 'verified' | 'quarantined' | 'paused' | 'released' | 'retained-original';
  carrierRole: 'local' | 'technical';
  processedRecords: number;
  retiredRecords?: number;
  canonicalRecords: number;
  segments: MigrationFileReceipt[];
  aliases: MigrationFileReceipt[];
  error: string | null;
}
export interface MigrationInventory {
  schema: 'mizar-diagnostic-migration/2';
  sources: MigrationSource[];
  updatedAt: string;
  policy: 'identity-union-preserve-variants-no-wire-reencoding';
}
async function* chunks(root: string, name: string, maxBytes: number): AsyncGenerator<Buffer> {
  const path = await safePath(root, name);
  const before = await lstat(path);
  if (before.size > maxBytes) throw new Error('migration_source_budget');
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const actual = await file.stat();
    if (
      actual.dev !== before.dev ||
      actual.ino !== before.ino ||
      actual.nlink !== 1 ||
      actual.size !== before.size
    )
      throw new Error('migration_source_changed');
    let offset = 0;
    while (offset < before.size) {
      const buffer = Buffer.alloc(Math.min(64 * 1024, before.size - offset));
      const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
      if (!bytesRead) throw new Error('migration_source_truncated');
      offset += bytesRead;
      yield buffer.subarray(0, bytesRead);
    }
    const after = await file.stat();
    const named = await lstat(await safePath(root, name));
    if (
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ino !== named.ino ||
      after.dev !== named.dev
    )
      throw new Error('migration_source_changed');
  } finally {
    await file.close();
  }
}
async function describe(root: string, name: string, maxBytes = LIMIT.sourceBytes) {
  const digest = createHash('sha256');
  let bytes = 0;
  for await (const chunk of chunks(root, name, maxBytes)) {
    digest.update(chunk);
    bytes += chunk.length;
  }
  return { bytes, sha256: digest.digest('hex') };
}
async function bytes(root: string, name: string, maxBytes: number) {
  const parts: Buffer[] = [];
  for await (const chunk of chunks(root, name, maxBytes)) parts.push(chunk);
  return Buffer.concat(parts);
}
async function* lines(input: AsyncIterable<Buffer>): AsyncGenerator<string> {
  let tail = Buffer.alloc(0);
  for await (const chunk of input) {
    tail = Buffer.concat([tail, chunk]);
    let end: number;
    while ((end = tail.indexOf(10)) >= 0) {
      if (end > LIMIT.lineBytes) throw new Error('migration_line_budget');
      yield tail.subarray(0, end).toString('utf8');
      tail = tail.subarray(end + 1);
    }
    if (tail.length > LIMIT.lineBytes) throw new Error('migration_line_budget');
  }
  if (tail.length) throw new Error('migration_incomplete_tail');
}
function utc(value: unknown) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
    ? new Date(value).toISOString()
    : null;
}
function normalized(value: unknown, source: MigrationSource, ordinal: number) {
  const input = record(diagnosticValue(value));
  const originalSource = record(input.source ?? record(input.evidence).sourceRecord);
  const uuid = (value: unknown): value is string =>
    typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
  const canonical =
    input.schema === 'mizar-diagnostic-event/2' &&
    typeof input.eventId === 'string' &&
    /^[a-zA-Z0-9_.:-]{1,256}$/.test(input.eventId) &&
    Number.isSafeInteger(input.sequence) &&
    Number(input.sequence) > 0;
  const performanceRecord =
    typeof input.stage === 'string' &&
    input.stage.startsWith('performance_anomaly_') &&
    uuid(originalSource.sessionId) &&
    Number.isSafeInteger(originalSource.recordSequence);
  const nativeIdentity =
    typeof input.sourceIdentity === 'string'
      ? input.sourceIdentity
      : typeof input.binding === 'string'
        ? input.binding
        : null;
  // A generic business record.id is never an event identity. Two identical actions remain two carriers.
  const existingId = canonical
    ? (input.eventId as string)
    : performanceRecord && uuid(input.id)
      ? input.id
      : performanceRecord && uuid(input.sourceRecordId)
        ? input.sourceRecordId
        : typeof input.sourceRecordId === 'string' && nativeIdentity
          ? `native:${hash(nativeIdentity)}:${hash(input.sourceRecordId)}`
          : null;
  const run =
    canonical && typeof input.producerRunId === 'string'
      ? input.producerRunId
      : performanceRecord
        ? String(originalSource.sessionId)
        : uuid(input.startupSessionId)
          ? input.startupSessionId
          : 'legacy-unknown';
  const sequence = performanceRecord
    ? Number(originalSource.recordSequence)
    : Number.isSafeInteger(input.sequence)
      ? Number(input.sequence)
      : ordinal + 1;
  const eventId =
    existingId ??
    (run !== 'legacy-unknown' && Number.isSafeInteger(input.sequence) && Number(input.sequence) > 0
      ? `${run}:${sequence}`
      : `legacy:${source.key}:${ordinal}`);
  const event = canonical
    ? input
    : {
        schema: 'mizar-diagnostic-event/2',
        eventId,
        producerKind: 'legacy-unknown',
        producerRunId: run,
        sequence,
        kind: typeof input.stage === 'string' ? input.stage : 'legacy_record',
        phase: typeof input.phase === 'string' ? input.phase : null,
        outcome: typeof input.result === 'string' ? input.result : null,
        observedAt: utc(performanceRecord ? originalSource.time : (input.time ?? input.recordedAt)),
        recordedAt: utc(input.recordedAt ?? input.time ?? originalSource.time),
        monotonicMs:
          typeof originalSource.monotonicMs === 'number' ? originalSource.monotonicMs : null,
        sourceInterval: null,
        taskId: input.taskId ?? null,
        operationId: input.operationId ?? input.browserOperationId ?? input.requestId ?? null,
        parentOperationId: input.parentOperationId ?? null,
        attemptId: input.attemptId ?? null,
        scope: input.scope ?? null,
        // Preserve the original record, not a guessed recursive merge of carrier variants.
        evidence: input,
        coverage: {
          durability: 'committed',
          occurrences: 1,
          replayCount: 0,
          unknown: ['legacy-producer-and-time-coverage'],
          excluded: [],
        },
      };
  const variantId = hash(JSON.stringify(event));
  return {
    eventId,
    variantId,
    event: {
      ...event,
      migration: {
        sourceKey: source.key,
        ordinal,
        carrierRole: source.carrierRole,
        variantId,
        resolution: 'preserve-source-variant',
      },
    },
  };
}
async function* legacyRecords(root: string, source: MigrationSource): AsyncGenerator<unknown> {
  if (/\.ndjson(?:\.\d+)?$/.test(source.name)) {
    for await (const line of lines(chunks(root, source.name, LIMIT.sourceBytes))) {
      if (!line.trim()) continue;
      try {
        yield JSON.parse(line);
      } catch {
        yield { stage: 'legacy_unparsed_record', text: line };
      }
    }
    return;
  }
  if (source.name.startsWith('diagnostic-outbox/')) {
    const compressed = await bytes(root, source.name, 512 * 1024);
    if (hash(compressed) !== source.name.split('/')[1]!.slice(0, -3))
      throw new Error('migration_wire_integrity');
    const raw = await inflate(compressed, { maxOutputLength: 4 * 1024 * 1024 });
    const bundle = record(JSON.parse(raw.toString('utf8')));
    if (
      bundle.schema !== 'mizar-technical-diagnostics/1' ||
      !Array.isArray(bundle.events) ||
      bundle.events.length > 4096
    )
      throw new Error('migration_wire_format');
    for (const event of bundle.events) yield event;
    return;
  }
  const value = record(
    JSON.parse((await bytes(root, source.name, LIMIT.jsonBytes)).toString('utf8')),
  );
  if (source.name.startsWith('performance-pending/')) {
    if (value.schema !== 'mizar-performance-pending/1' || typeof value.gzipBase64 !== 'string')
      throw new Error('migration_performance_format');
    const raw = await inflate(Buffer.from(value.gzipBase64, 'base64'), {
      maxOutputLength: 1024 * 1024,
    });
    if (raw.length !== value.expandedBytes || hash(raw) !== value.sha256)
      throw new Error('migration_performance_integrity');
    const events = JSON.parse(raw.toString('utf8'));
    if (!Array.isArray(events) || events.length > 8192)
      throw new Error('migration_performance_format');
    for (const event of events) yield event;
  } else if (source.name === 'business-history.json') {
    if (!Array.isArray(value.groups)) throw new Error('migration_business_format');
    for (const group of value.groups) {
      const body = record(group);
      if (!Array.isArray(body.events)) throw new Error('migration_business_format');
      for (const event of body.events)
        yield {
          ...record(event),
          legacyBusinessScope: { matchId: body.matchId, liveSessionId: body.liveSessionId },
        };
    }
  } else if (source.name.startsWith('marked-incidents/')) {
    if (
      value.schema !== 'mizar-incident/1' ||
      !Array.isArray(value.files) ||
      value.files.length > 64
    )
      throw new Error('migration_incident_format');
    yield { stage: 'legacy_incident_marker', capturedAt: value.capturedAt, evidence: value.report };
    for (const item of value.files) {
      const file = record(item);
      if (!Array.isArray(file.volumes)) throw new Error('migration_incident_format');
      let decodedBytes = 0;
      const expanded = async function* () {
        for (const item of file.volumes as unknown[]) {
          const volume = record(item);
          if (typeof volume.gzipBase64 !== 'string') throw new Error('migration_incident_format');
          const raw = await inflate(Buffer.from(volume.gzipBase64, 'base64'), {
            maxOutputLength: 1024 * 1024,
          });
          if (raw.length !== volume.bytes || hash(raw) !== volume.sha256)
            throw new Error('migration_incident_integrity');
          decodedBytes += raw.length;
          if (decodedBytes > LIMIT.sourceBytes)
            throw new Error('migration_incident_expansion_budget');
          yield raw;
        }
      };
      if (typeof file.name === 'string' && /\.json$/.test(file.name)) {
        const parts: Buffer[] = [];
        for await (const chunk of expanded()) {
          if (decodedBytes > LIMIT.jsonBytes) throw new Error('migration_json_budget');
          parts.push(chunk);
        }
        yield {
          stage: 'legacy_incident_json',
          sourceName: file.name,
          evidence: JSON.parse(Buffer.concat(parts).toString('utf8')),
        };
      } else {
        for await (const line of lines(expanded())) {
          if (!line.trim()) continue;
          try {
            yield JSON.parse(line);
          } catch {
            yield { stage: 'legacy_incident_text', sourceName: file.name, text: line };
          }
        }
      }
    }
  } else throw new Error('migration_source_unsupported');
}
async function discover(root: string): Promise<string[]> {
  const names = (await readdir(root)).filter((name) => legacyName.test(name));
  for (const directory of ['diagnostic-outbox', 'performance-pending', 'marked-incidents']) {
    try {
      await safePath(join(root, directory));
      for (const name of await readdir(join(root, directory)))
        if (legacyName.test(`${directory}/${name}`)) names.push(`${directory}/${name}`);
    } catch (error) {
      if (!missing(error)) throw error;
    }
  }
  if (names.length > LIMIT.sources) throw new Error('migration_source_count_budget');
  // Local full records precede their intentionally narrower transport copies.
  return names.sort(
    (a, b) =>
      Number(a.startsWith('diagnostic-outbox/')) - Number(b.startsWith('diagnostic-outbox/')) ||
      a.localeCompare(b),
  );
}
async function publish(
  root: string,
  name: string,
  contents: string,
  records: number,
): Promise<MigrationFileReceipt> {
  if (!outputName.test(name)) throw new Error('migration_output_invalid');
  await safePath(
    name.startsWith('diagnostic-migration/') ? join(root, 'diagnostic-migration') : root,
  );
  const file = await open(
    join(root, name),
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    await file.writeFile(contents);
    await file.sync();
  } finally {
    await file.close();
  }
  await syncDirectory(dirname(join(root, name)));
  const receipt = { name, bytes: Buffer.byteLength(contents), sha256: hash(contents), records };
  const verified = await describe(root, name, LIMIT.lineBytes);
  if (verified.sha256 !== receipt.sha256 || verified.bytes !== receipt.bytes)
    throw new Error('migration_output_integrity');
  return receipt;
}

/** One bounded upgrade pass. Old files and old wire bytes are never modified here. */
export class DiagnosticMigration {
  private loaded = false;
  private known = new Map<string, Map<string, string>>();
  private outputBytes = 0;
  private budgetDirty = false;
  private serial: Promise<unknown> = Promise.resolve();
  private inventory: MigrationInventory = {
    schema: 'mizar-diagnostic-migration/2',
    policy: 'identity-union-preserve-variants-no-wire-reencoding',
    updatedAt: new Date().toISOString(),
    sources: [],
  };
  constructor(
    private readonly root: string,
    private readonly protection?: (files: readonly MigrationFileReceipt[]) => Promise<boolean>,
  ) {}
  private async save() {
    this.inventory.updatedAt = new Date().toISOString();
    if (Buffer.byteLength(JSON.stringify(this.inventory)) > LIMIT.inventoryBytes)
      throw new Error('migration_inventory_budget');
    await atomicJson(join(this.root, 'diagnostic-migration', 'inventory.json'), this.inventory);
  }
  run(options: { signal?: AbortSignal; maxNewBytes?: number; onlySources?: string[] } = {}) {
    const result = this.serial.then(() => this.migrate(options));
    this.serial = result.catch(() => undefined);
    return result;
  }
  private async migrate(options: {
    signal?: AbortSignal;
    maxNewBytes?: number;
    onlySources?: string[];
  }) {
    await mkdir(join(this.root, 'diagnostic-migration'), { recursive: true });
    await safePath(this.root);
    if (!this.loaded) {
      try {
        const value = JSON.parse(
          (
            await bytes(this.root, 'diagnostic-migration/inventory.json', LIMIT.inventoryBytes)
          ).toString('utf8'),
        ) as MigrationInventory;
        if (
          value.schema !== this.inventory.schema ||
          !Array.isArray(value.sources) ||
          value.sources.length > LIMIT.sources ||
          value.sources.some(
            (source) =>
              !legacyName.test(source.name) ||
              !Array.isArray(source.segments) ||
              !Array.isArray(source.aliases) ||
              !Number.isSafeInteger(source.processedRecords) ||
              source.processedRecords < 0 ||
              !Number.isSafeInteger(source.canonicalRecords) ||
              source.canonicalRecords < 0 ||
              source.aliases.reduce((sum, file) => sum + file.records, 0) !==
                source.processedRecords ||
              source.segments.reduce((sum, file) => sum + file.records, 0) !==
                source.canonicalRecords ||
              [...source.segments, ...source.aliases].some(
                (file) =>
                  !outputName.test(file.name) ||
                  !Number.isSafeInteger(file.records) ||
                  file.records < 0 ||
                  !Number.isSafeInteger(file.bytes) ||
                  file.bytes < 0 ||
                  !/^[a-f0-9]{64}$/.test(file.sha256),
              ) ||
              (!(source.sha256 === null && ['quarantined', 'paused'].includes(source.status)) &&
                !/^[a-f0-9]{64}$/.test(source.sha256 ?? '')),
          )
        )
          throw new Error('migration_inventory_invalid');
        this.inventory = value;
      } catch (error) {
        if (!missing(error)) throw error;
      }
      const known = this.known;
      known.clear();
      for (const source of this.inventory.sources)
        for (const segment of source.segments) {
          if (!outputName.test(segment.name)) throw new Error('migration_inventory_output_invalid');
          const actual = await describe(this.root, segment.name, LIMIT.lineBytes);
          if (actual.sha256 !== segment.sha256 || actual.bytes !== segment.bytes)
            throw new Error('migration_committed_output_unavailable');
          for await (const line of lines(chunks(this.root, segment.name, LIMIT.lineBytes))) {
            const event = record(JSON.parse(line));
            const variant = record(event.migration);
            if (typeof event.eventId !== 'string' || typeof variant.variantId !== 'string')
              throw new Error('migration_committed_output_format');
            const variants = known.get(event.eventId) ?? new Map<string, string>();
            variants.set(variant.variantId, segment.name);
            known.set(event.eventId, variants);
            if (known.size > LIMIT.identities) throw new Error('migration_identity_budget');
          }
        }
      let existingOutputBytes = 0;
      for (const directory of ['', 'diagnostic-migration']) {
        const prefix = directory ? `${directory}/` : '';
        for (const entry of await readdir(join(this.root, directory))) {
          const name = prefix + entry;
          if (!outputName.test(name)) continue;
          existingOutputBytes += (await lstat(await safePath(this.root, name))).size;
        }
      }
      this.outputBytes = existingOutputBytes;
      this.loaded = true;
    }
    const known = this.known;
    if (this.budgetDirty) {
      let actualBytes = 0;
      for (const directory of ['', 'diagnostic-migration'])
        for (const name of await readdir(join(this.root, directory))) {
          const relative = directory ? `${directory}/${name}` : name;
          if (outputName.test(relative))
            actualBytes += (await lstat(await safePath(this.root, relative))).size;
        }
      this.outputBytes = actualBytes;
      this.budgetDirty = false;
    }
    const existingOutputBytes = this.outputBytes;
    let written = 0;
    const sources = options.onlySources ?? (await discover(this.root));
    if (sources.some((name) => !legacyName.test(name))) throw new Error('migration_source_invalid');
    for (const name of sources) {
      options.signal?.throwIfAborted();
      if (
        options.onlySources &&
        this.inventory.sources.some(
          (source) => source.name === name && source.status === 'verified',
        )
      )
        continue;
      let source = this.inventory.sources.find(
        (value) => value.name === name && value.status !== 'released',
      );
      try {
        const original = await describe(this.root, name);
        if (source && source.sha256 !== original.sha256) {
          source.status = 'quarantined';
          source.error = 'migration_source_changed';
          await this.save();
          // Keep the prior generation's checkpoint, but let a now-stable repaired
          // or completed file migrate under its own digest instead of blocking forever.
          source = this.inventory.sources.find(
            (value) =>
              value.name === name &&
              value.sha256 === original.sha256 &&
              value.status !== 'released',
          );
        }
        if (!source) {
          source = {
            key: hash(`${name}:${original.sha256}`),
            name,
            ...original,
            status: 'pending',
            carrierRole: name.startsWith('diagnostic-outbox/') ? 'technical' : 'local',
            processedRecords: 0,
            canonicalRecords: 0,
            segments: [],
            aliases: [],
            error: null,
          };
          this.inventory.sources.push(source);
          await this.save();
        }
        if (/^(?:supervisor\.|companion(?:\.stderr)?\.log)/.test(name)) {
          source.status = 'retained-original';
          source.error = null;
          await this.save();
          continue;
        }
        if (['verified', 'quarantined', 'retained-original'].includes(source.status)) continue;
        const target = source;
        let body = '';
        let aliases = '';
        let bodyCount = 0;
        let processed = 0;
        let pendingCount = 0;
        let segmentName = `migrated-${randomUUID()}.ndjson`;
        const pending: { eventId: string; variantId: string; segment: string }[] = [];
        const flush = async () => {
          if (!pendingCount) return;
          const additional = Buffer.byteLength(body) + Buffer.byteLength(aliases);
          if (
            written + additional > (options.maxNewBytes ?? LIMIT.stagingBytes) ||
            existingOutputBytes + written + additional > LIMIT.stagingBytes
          )
            throw new Error('migration_staging_budget');
          written += additional;
          this.outputBytes += additional; // Reserve before either write; failed partial output also uses disk.
          const nextSegments = body ? [await publish(this.root, segmentName, body, bodyCount)] : [];
          const nextAliases = await publish(
            this.root,
            `diagnostic-migration/aliases-${randomUUID()}.ndjson`,
            aliases,
            pendingCount,
          );
          target.segments.push(...nextSegments);
          target.aliases.push(nextAliases);
          target.processedRecords += pendingCount;
          target.canonicalRecords += bodyCount;
          try {
            await this.save();
          } catch (error) {
            target.segments.splice(
              target.segments.length - nextSegments.length,
              nextSegments.length,
            );
            target.aliases.pop();
            target.processedRecords -= pendingCount;
            target.canonicalRecords -= bodyCount;
            throw error;
          }
          for (const item of pending) {
            const variants = known.get(item.eventId) ?? new Map<string, string>();
            variants.set(item.variantId, item.segment);
            known.set(item.eventId, variants);
          }
          body = '';
          aliases = '';
          bodyCount = 0;
          pendingCount = 0;
          pending.length = 0;
          segmentName = `migrated-${randomUUID()}.ndjson`;
        };
        for await (const raw of legacyRecords(this.root, target)) {
          if (processed++ < target.processedRecords) continue;
          options.signal?.throwIfAborted();
          const value = normalized(raw, target, processed - 1);
          if (!known.has(value.eventId) && known.size + pending.length >= LIMIT.identities)
            throw new Error('migration_identity_budget');
          const encoded = JSON.stringify(value.event) + '\n';
          if (Buffer.byteLength(encoded) > LIMIT.segmentBytes)
            throw new Error('migration_event_budget');
          if (
            Buffer.byteLength(body) + Buffer.byteLength(encoded) > LIMIT.segmentBytes ||
            Buffer.byteLength(aliases) > LIMIT.segmentBytes / 2
          )
            await flush();
          const existing =
            known.get(value.eventId)?.get(value.variantId) ??
            pending.find(
              (item) => item.eventId === value.eventId && item.variantId === value.variantId,
            )?.segment;
          const canonicalSegment = existing ?? segmentName;
          if (!existing) {
            body += encoded;
            bodyCount++;
            pending.push({
              eventId: value.eventId,
              variantId: value.variantId,
              segment: canonicalSegment,
            });
          }
          aliases +=
            JSON.stringify({
              sourceKey: target.key,
              ordinal: processed - 1,
              eventId: value.eventId,
              variantId: value.variantId,
              canonicalSegment,
              carrierRole: target.carrierRole,
            }) + '\n';
          pendingCount++;
        }
        await flush();
        if (processed !== target.processedRecords)
          throw new Error('migration_checkpoint_count_mismatch');
        const final = await describe(this.root, name);
        if (final.sha256 !== target.sha256 || final.bytes !== target.bytes)
          throw new Error('migration_source_changed');
        target.status = 'verified';
        target.error = null;
        await this.save();
      } catch (error) {
        if (options.signal?.aborted) throw error;
        const reason = error instanceof Error ? error.message : 'migration_source_failed';
        if (!source) {
          source = {
            key: hash(`unreadable:${name}`),
            name,
            sha256: null,
            bytes: null,
            status: 'quarantined',
            carrierRole: name.startsWith('diagnostic-outbox/') ? 'technical' : 'local',
            processedRecords: 0,
            canonicalRecords: 0,
            segments: [],
            aliases: [],
            error: reason,
          };
          this.inventory.sources.push(source);
        }
        if (source) {
          source.status = /budget|ENOSPC|EACCES|EPERM/.test(reason) ? 'paused' : 'quarantined';
          source.error = reason;
          await this.save();
        }
        // A corrupt source is quarantined in place. Other sources still migrate.
      }
    }
    return { ...structuredClone(this.inventory), writtenBytes: written, uniqueEvents: known.size };
  }
  wireCoverage(id: string): Promise<MigrationFileReceipt[] | null> {
    const result = this.serial.then(async () => {
      if (!/^[a-f0-9]{64}$/.test(id)) return null;
      const source = this.inventory.sources.find(
        (item) =>
          item.name === `diagnostic-outbox/${id}.gz` &&
          item.sha256 === id &&
          item.status === 'verified',
      );
      if (!source || source.retiredRecords || !source.processedRecords) return null;
      try {
        const original = await describe(this.root, source.name, 512 * 1024);
        if (original.sha256 !== id || original.bytes !== source.bytes)
          throw new Error('migration_wire_changed');
        const raw = await inflate(await bytes(this.root, source.name, 512 * 1024), {
          maxOutputLength: 4 * 1024 * 1024,
        });
        const payload = record(JSON.parse(raw.toString('utf8')));
        if (!Array.isArray(payload.events) || payload.events.length !== source.processedRecords)
          throw new Error('migration_wire_coverage_count');
      } catch (error) {
        // Crash between protected unlink and sender manifest commit: the prior
        // verified wire digest/checkpoint still proves which body was replaced.
        if (!missing(error)) throw error;
      }
      const segments = new Map(
        this.inventory.sources.flatMap((item) => item.segments).map((file) => [file.name, file]),
      );
      const required = new Map<string, MigrationFileReceipt>();
      let ordinal = 0;
      for (const alias of source.aliases) {
        const actual = await describe(this.root, alias.name, LIMIT.lineBytes);
        if (actual.sha256 !== alias.sha256 || actual.bytes !== alias.bytes)
          throw new Error('migration_alias_unavailable');
        for await (const line of lines(chunks(this.root, alias.name, LIMIT.lineBytes))) {
          const value = record(JSON.parse(line));
          if (value.sourceKey !== source.key || value.ordinal !== ordinal++)
            throw new Error('migration_alias_coverage_invalid');
          const body = segments.get(String(value.canonicalSegment));
          if (!body) throw new Error('migration_alias_unresolved');
          required.set(body.name, body);
        }
      }
      if (ordinal !== source.processedRecords) throw new Error('migration_alias_coverage_invalid');
      for (const body of required.values()) {
        const actual = await describe(this.root, body.name, LIMIT.lineBytes);
        if (actual.bytes !== body.bytes || actual.sha256 !== body.sha256)
          throw new Error('migration_replacement_unavailable');
      }
      return [...required.values()];
    });
    this.serial = result.catch(() => undefined);
    return result;
  }
  senderReleasedWire(id: string): Promise<void> {
    const result = this.serial.then(async () => {
      const source = this.inventory.sources.find(
        (item) =>
          item.name === `diagnostic-outbox/${id}.gz` &&
          item.sha256 === id &&
          item.status === 'verified',
      );
      if (source) {
        source.status = 'released';
        await this.save();
      }
    });
    this.serial = result.catch(() => undefined);
    return result;
  }
  /** Explicit cold-source cleanup only after all referenced replacements are reverified.
   * Pending and acknowledged wire files remain the sender's responsibility. */
  releaseVerifiedSource(key: string): Promise<boolean> {
    const result = this.serial.then(async () => {
      const source = this.inventory.sources.find((value) => value.key === key);
      if (
        !source ||
        source.status !== 'verified' ||
        source.retiredRecords ||
        source.name.startsWith('diagnostic-outbox/')
      )
        return false;
      if (source.bytes && !source.processedRecords) return false;
      let expectedOrdinal = 0;
      const allSegments = new Map(
        this.inventory.sources.flatMap((item) => item.segments).map((file) => [file.name, file]),
      );
      const required = new Map(source.segments.map((file) => [file.name, file]));
      for (const alias of source.aliases) {
        const actual = await describe(this.root, alias.name, LIMIT.lineBytes);
        if (actual.bytes !== alias.bytes || actual.sha256 !== alias.sha256)
          throw new Error('migration_alias_unavailable');
        for await (const line of lines(chunks(this.root, alias.name, LIMIT.lineBytes))) {
          const value = record(JSON.parse(line));
          if (value.sourceKey !== source.key || value.ordinal !== expectedOrdinal++)
            throw new Error('migration_alias_coverage_invalid');
          const replacement = allSegments.get(String(value.canonicalSegment));
          if (!replacement) throw new Error('migration_alias_unresolved');
          required.set(replacement.name, replacement);
        }
      }
      if (expectedOrdinal !== source.processedRecords)
        throw new Error('migration_alias_coverage_invalid');
      for (const replacement of required.values()) {
        const actual = await describe(this.root, replacement.name, LIMIT.lineBytes);
        if (actual.bytes !== replacement.bytes || actual.sha256 !== replacement.sha256)
          throw new Error('migration_replacement_unavailable');
      }
      // Cross-carrier aliases can depend on bodies created while migrating another source.
      if (!this.protection || !(await this.protection([...required.values()]))) return false;
      const current = await describe(this.root, source.name);
      if (current.sha256 !== source.sha256 || current.bytes !== source.bytes)
        throw new Error('migration_source_changed');
      await unlink(await safePath(this.root, source.name));
      source.status = 'released';
      await this.save();
      return true;
    });
    this.serial = result.catch(() => undefined);
    return result;
  }
  /** Replace navigation targets with explicit tombstones before retention unlinks bodies. */
  retireReferences(names: readonly string[]): Promise<void> {
    const result = this.serial.then(async () => {
      const retiring = new Set(names);
      this.budgetDirty = true;
      for (const [eventId, variants] of this.known) {
        for (const [variantId, segment] of variants)
          if (retiring.has(segment)) variants.delete(variantId);
        if (!variants.size) this.known.delete(eventId);
      }

      const previous = structuredClone(this.inventory);
      const oldAliases: MigrationFileReceipt[] = [];
      try {
        for (const source of this.inventory.sources) {
          source.segments = source.segments.filter((segment) => !retiring.has(segment.name));
          source.canonicalRecords = source.segments.reduce((sum, file) => sum + file.records, 0);
          for (let index = 0; index < source.aliases.length; index++) {
            const alias = source.aliases[index]!;
            const actual = await describe(this.root, alias.name, LIMIT.lineBytes);
            if (actual.sha256 !== alias.sha256 || actual.bytes !== alias.bytes)
              throw new Error('migration_alias_unavailable');
            let output = '';
            let changed = 0;
            for await (const line of lines(chunks(this.root, alias.name, LIMIT.lineBytes))) {
              const value = record(JSON.parse(line));
              if (
                typeof value.canonicalSegment === 'string' &&
                retiring.has(value.canonicalSegment)
              ) {
                value.canonicalSegment = null;
                value.coverage = 'canonical-retention-expired';
                value.retiredAt = new Date().toISOString();
                changed++;
              }
              output += JSON.stringify(value) + '\n';
            }
            if (changed) {
              source.aliases[index] = await publish(
                this.root,
                `diagnostic-migration/aliases-${randomUUID()}.ndjson`,
                output,
                alias.records,
              );
              source.retiredRecords = (source.retiredRecords ?? 0) + changed;
              if (source.status === 'verified') source.status = 'retained-original';
              oldAliases.push(alias);
            }
          }
        }
        await this.save();
      } catch (error) {
        this.inventory = previous;
        throw error;
      }
      for (const alias of oldAliases) {
        const actual = await describe(this.root, alias.name, LIMIT.lineBytes);
        if (actual.sha256 !== alias.sha256) throw new Error('migration_alias_changed');
        await unlink(await safePath(this.root, alias.name));
      }
    });
    this.serial = result.catch(() => undefined);
    return result;
  }
  snapshot() {
    return structuredClone(this.inventory);
  }
}

/** Check all fixed persistent pin carriers before retiring a legacy local body. */
async function legacySourcePinned(root: string, sourceName: string): Promise<boolean> {
  const files = (await readdir(root)).filter(
    (name) => /^retention-[a-z0-9_-]+\.json$/.test(name) || name === 'incident-pins.json',
  );
  try {
    for (const name of await readdir(join(root, 'host-pins')))
      if (/^[a-f0-9-]{36}\.json$/.test(name)) files.push(`host-pins/${name}`);
  } catch (error) {
    if (!missing(error)) return true;
  }
  const active = (pin: Record<string, unknown>) => {
    const until = typeof pin.expiresAt === 'string' ? Date.parse(pin.expiresAt) : pin.expiresAt;
    return (
      until === null || typeof until !== 'number' || !Number.isFinite(until) || until > Date.now()
    );
  };
  for (const name of files) {
    try {
      const value = record(JSON.parse((await bytes(root, name, 4 * 1024 * 1024)).toString('utf8')));
      const pins = name.startsWith('host-pins/')
        ? [value]
        : Array.isArray(value.pins)
          ? value.pins
          : Array.isArray(value.marks)
            ? value.marks.flatMap((mark) =>
                Array.isArray(record(mark).receipts) ? (record(mark).receipts as unknown[]) : [],
              )
            : null;
      if (!pins) return true;
      for (const item of pins) {
        const pin = record(item);
        if (
          active(pin) &&
          Array.isArray(pin.segments) &&
          pin.segments.some((segment) => record(segment).name === sourceName)
        )
          return true;
      }
    } catch {
      return true;
    }
  }
  return false;
}

/** Background lifecycle adapter. Does not hold service readiness or business operations. */
function createMigrationRuntime(root: string, journal: SessionJournal) {
  const retention = new ProducerRetention(root, 'migration', {
    budgetBytes: LIMIT.stagingBytes,
    retentionMs: 14 * 86400_000,
  });
  const leases: string[] = [];
  const registered = new Set<string>();
  const register = async (files: readonly MigrationFileReceipt[]) => {
    for (const file of files) {
      if (registered.has(file.name)) continue;
      await retention.registerSegment(file.name, {
        producerRunId: 'legacy-unknown',
        firstSequence: null,
        lastSequence: null,
        firstObservedAt: null,
        lastObservedAt: null,
        records: file.records,
      });
      registered.add(file.name);
    }
  };
  const migration = new DiagnosticMigration(root, async (files) => {
    await register(files);
    const pinId = randomUUID();
    await retention.preparePin({
      pinId,
      kind: 'export',
      names: files.map((file) => file.name),
      expiresAt: Date.now() + 15 * 60_000,
    });
    await retention.commitPin(pinId);
    leases.push(pinId);
    return true;
  });
  let serial: Promise<unknown> = Promise.resolve();
  const run = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = serial.then(operation);
    serial = result.catch(() => undefined);
    return result;
  };
  let initialized = false;
  const initialize = async () => {
    await retention.initialize();
    if (!initialized) {
      const result = await migration.run({ onlySources: [] });
      await register(result.sources.flatMap((source) => source.segments));
      initialized = true;
    }
  };
  const controller = new AbortController();
  let status: 'running' | 'completed' | 'partial' | 'failed' | 'stopped' = 'running';
  let error: string | null = null;
  let writtenBytes = 0;
  let blockedCleanup = 0;
  const health = () => {
    const sources = migration.snapshot().sources;
    return {
      status,
      error,
      writtenBytes,
      sources: sources.length,
      verifiedSources: sources.filter((source) => source.status === 'verified').length,
      releasedSources: sources.filter((source) => source.status === 'released').length,
      pausedSources: sources.filter((source) => source.status === 'paused').length,
      quarantinedSources: sources.filter((source) => source.status === 'quarantined').length,
      retainedOriginals: sources.filter((source) => source.status !== 'released').length,
      retiredRecords: sources.reduce((sum, source) => sum + (source.retiredRecords ?? 0), 0),
      blockedCleanup,
      cleanup: 'verified-local-only; incident-originals-and-wire-retained',
    };
  };
  const work = () =>
    run(async () => {
      try {
        await retention.initialize();
        const result = await migration.run({ signal: controller.signal });
        writtenBytes = result.writtenBytes;
        await register(result.sources.flatMap((source) => source.segments));
        for (const source of result.sources) {
          controller.signal.throwIfAborted();
          if (
            source.status !== 'verified' ||
            source.name.startsWith('diagnostic-outbox/') ||
            source.name.startsWith('marked-incidents/')
          )
            continue;
          if (await legacySourcePinned(root, source.name)) {
            blockedCleanup++;
            continue;
          }
          try {
            if (!(await migration.releaseVerifiedSource(source.key))) blockedCleanup++;
          } finally {
            for (const pinId of leases.splice(0)) await retention.releasePin(pinId);
          }
        }
        await retention.collect({
          incomingBytes: 0,
          beforeDelete: (segments) =>
            migration.retireReferences(segments.map((segment) => segment.name)),
        });
        status =
          migration
            .snapshot()
            .sources.some(
              (source) => !['verified', 'released', 'retained-original'].includes(source.status),
            ) || blockedCleanup
            ? 'partial'
            : 'completed';
        journal.record('diagnostic_migration_result', health());
      } catch (cause) {
        status = controller.signal.aborted ? 'stopped' : 'failed';
        error = cause instanceof Error ? cause.message : 'migration_failed';
        journal.record('diagnostic_migration_result', {
          ...health(),
          cause: diagnosticValue(cause),
        });
      } finally {
        for (const pinId of leases.splice(0)) {
          try {
            await retention.releasePin(pinId);
          } catch {
            /* Lease expires; no unconfirmed source deletion is retried. */
          }
        }
      }
    });
  let started: Promise<void> | undefined;
  return {
    health,
    start() {
      started ??= work();
      return started;
    },
    coverWire(id: string, release: () => Promise<void>) {
      return run(async () => {
        if (controller.signal.aborted) return false;
        await initialize();
        await retention.collect({
          incomingBytes: 8 * 1024 * 1024,
          beforeDelete: (segments) =>
            migration.retireReferences(segments.map((segment) => segment.name)),
        });
        const result = await migration.run({
          signal: controller.signal,
          onlySources: [`diagnostic-outbox/${id}.gz`],
          maxNewBytes: 8 * 1024 * 1024,
        });
        await register(result.sources.flatMap((source) => source.segments));
        const files = await migration.wireCoverage(id);
        if (!files) return false;
        await register(files);
        const pinId = randomUUID();
        await retention.preparePin({
          pinId,
          kind: 'export',
          names: files.map((file) => file.name),
          expiresAt: Date.now() + 15 * 60_000,
        });
        await retention.commitPin(pinId);
        try {
          await release();
          await migration.senderReleasedWire(id);
        } finally {
          await retention.releasePin(pinId);
        }
        return true;
      });
    },
    async stop() {
      controller.abort();
      await serial;
    },
  };
}

const migrationRuntimes = new Map<string, ReturnType<typeof createMigrationRuntime>>();
function migrationRuntime(root: string, journal: SessionJournal) {
  const key = resolve(root);
  let runtime = migrationRuntimes.get(key);
  if (!runtime) {
    runtime = createMigrationRuntime(key, journal);
    migrationRuntimes.set(key, runtime);
  }
  return runtime;
}
export function startDiagnosticMigration(root: string, journal: SessionJournal) {
  const runtime = migrationRuntime(root, journal);
  void runtime.start();
  return {
    health: runtime.health,
    async stop() {
      await runtime.stop();
      const key = resolve(root);
      if (migrationRuntimes.get(key) === runtime) migrationRuntimes.delete(key);
    },
  };
}
/** Sender supplies the only deletion action, after a durable ACK and exact protected replacement proof. */
export function withAcknowledgedWireCoverage(
  root: string,
  journal: SessionJournal,
  id: string,
  release: () => Promise<void>,
) {
  return migrationRuntime(root, journal).coverWire(id, release);
}
