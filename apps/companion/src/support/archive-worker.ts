import { sourceCoversProjection } from './technical-projection.js';
import { diagnosticValue } from './session-journal.js';
import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { StringDecoder } from 'node:string_decoder';
import { performance } from 'node:perf_hooks';
import { Zip, ZipDeflate } from 'fflate';

export interface ArchiveWorkerData {
  sources: {
    name: string;
    fd: number;
    bytes: number;
    rawAttachment?: boolean;
    rawIndex?: boolean;
    secrets?: string[];
  }[];
  gaps: unknown[];
  excludedSources?: { source: string; reason: string }[];
  output: string;
  exportId: string;
  range: { from?: string; to?: string };
  snapshot: unknown;
  /** Remaining shared cache budget, after other jobs and this job's input snapshots. */
  diskBudgetBytes?: number;
  /** Completed by the owner before this worker starts. */
  collectionMs?: number;
}
type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as ObjectValue)
    : {};
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const MAX = 18_874_368;
const ENTRY_MAX = 2 * 1024 * 1024;
// The offline reader enforces the same expanded per-part ceiling. Reserve space
// for all three final metadata entries before accepting another ordinary entry.
const EXPANDED_MAX = 256 * 1024 * 1024;
const FINAL_METADATA_RESERVE = 3 * ENTRY_MAX;
const timestamp = (value: unknown) => (typeof value === 'string' ? Date.parse(value) : NaN);
const sensitive =
  /authorization|cookie|password|passwd|token|secret|credential|api[_-]?key|stream[_-]?key|ticket/i;
function redact(value: unknown, key = ''): unknown {
  const record = object(value);
  if (
    ['program_all_chat', 'program_all_chat_reset'].includes(String(record.kind ?? record.stage))
  ) {
    return {
      ...Object.fromEntries(
        Object.entries(record)
          .filter(([name]) =>
            [
              'schema',
              'eventId',
              'producerKind',
              'producerRunId',
              'sequence',
              'kind',
              'stage',
              'phase',
              'outcome',
              'time',
              'observedAt',
              'recordedAt',
              'startupSessionId',
              'taskId',
              'operationId',
              'parentOperationId',
              'attemptId',
              'sourceInterval',
            ].includes(name),
          )
          .map(([name, item]) => [name, redact(item, name)]),
      ),
      evidence: { excluded: 'raw-chat-body', scope: 'identity and source interval only' },
      coverage: { excluded: ['raw-chat-body'], unknown: [] },
    };
  }
  if (sensitive.test(key)) return '[redacted]';
  if (typeof value === 'string') {
    if (/^\s*[{[]/.test(value)) {
      try {
        return JSON.stringify(redact(JSON.parse(value)));
      } catch {
        /* Plain text remains evidence. */
      }
    }
    return value
      .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi, (text) => {
        try {
          const url = new URL(text);
          if (url.username || url.password) {
            url.username = '[redacted]';
            url.password = '';
          }
          for (const name of [...url.searchParams.keys()])
            if (/password|token|secret|credential|key|code|auth/i.test(name))
              url.searchParams.set(name, '[redacted]');
          if (/^rtmps?:$/.test(url.protocol)) {
            const parts = url.pathname.split('/');
            if (parts.length > 2) {
              parts[parts.length - 1] = '[redacted]';
              url.pathname = parts.join('/');
            }
          }
          return url.toString();
        } catch {
          return text;
        }
      })
      .replace(/\b(Bearer|Basic)\s+[^\s"',}]+/gi, '$1 [redacted]')
      .replace(
        /((?:password|passwd|token|secret|credential|api[_-]?key|stream[_-]?key|ticket)["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;}&?#]+)/gi,
        '$1[redacted]',
      );
  }
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(record).map(([name, item]) => [name, redact(item, name)]),
    );
  return value;
}
class OutputFailure extends Error {}
/** Synchronous, bounded work in one finite-lifetime worker; descriptors are pinned by the owner. */
export function runArchiveWorker(
  d: ArchiveWorkerData,
  report: (message: ObjectValue) => void,
): void {
  let zip: Zip,
    fd: number | undefined,
    bytes = 0,
    expandedBytes = 0,
    totalBytes = 0,
    part = 0;
  let digest = createHash('sha256');
  type Entry = { name: string; bytes: number; sha256: string };
  let entries: Entry[] = [];
  const parts: Entry[] = [],
    gaps = [...d.gaps];
  const excludedSources: { source: string; reason: string }[] = [...(d.excludedSources ?? [])];
  let carrierRecords = 0,
    uniqueEvents = 0,
    aggregatedOccurrences = 0,
    processedBytes = 0,
    indexBytes = 0;
  const indexDirectory = d.output + '/.identity-index';
  const budget = Math.min(d.diskBudgetBytes ?? 256 * 1024 * 1024, 256 * 1024 * 1024);
  const started = performance.now(),
    baseline = process.memoryUsage();
  let peakHeap = baseline.heapUsed,
    peakRss = baseline.rss,
    peakExternal = baseline.external;
  const stages = { readMs: 0, decodeMs: 0, encodeMs: 0, finalizeMs: 0 };
  const sample = () => {
    const m = process.memoryUsage();
    peakHeap = Math.max(peakHeap, m.heapUsed);
    peakRss = Math.max(peakRss, m.rss);
    peakExternal = Math.max(peakExternal, m.external);
  };
  function output<T>(action: () => T): T {
    try {
      return action();
    } catch (error) {
      throw new OutputFailure('export_output_failed', { cause: error });
    }
  }
  function writeAll(handle: number, data: Uint8Array) {
    let position = 0;
    while (position < data.length) {
      const written = fs.writeSync(handle, data, position, data.length - position);
      if (!written) throw Error('output_short_write');
      position += written;
    }
  }
  // Gzip is decoded once. Exact comparison facts are kept on disk with the
  // existing identity index, charged to the shared export budget, not in heap.
  let factsFd: number | undefined,
    factsBytes = 0;
  type Locator = {
    source: string;
    offset: number;
    length?: number;
    facts?: { offset: number; length: number };
  };
  function readGzip(source: ArchiveWorkerData['sources'][number]): unknown {
    if (source.bytes > 16 * 1024 * 1024) throw Error('source_decode_budget');
    const raw = Buffer.alloc(source.bytes);
    let position = 0;
    while (position < raw.length) position += read(source.fd, raw.subarray(position), position);
    const start = performance.now();
    const expanded = gunzipSync(raw, { maxOutputLength: 4 * 1024 * 1024 });
    const value: unknown = JSON.parse(expanded.toString('utf8'));
    stages.decodeMs += performance.now() - start;
    sample();
    return value;
  }
  function readCanonical(locator: Locator): ObjectValue {
    const source = d.sources.find((candidate) => candidate.name === locator.source);
    if (!source) throw Error('canonical_source_missing');
    const { offset, length } = locator.facts ?? locator;
    const handle = locator.facts ? factsFd : source.fd;
    const bytes = locator.facts ? factsBytes : source.bytes;
    if (handle === undefined) throw Error('canonical_facts_missing');
    if (
      !Number.isSafeInteger(length) ||
      length! <= 0 ||
      length! > ENTRY_MAX ||
      offset < 0 ||
      offset + length! >= bytes
    )
      throw Error('canonical_record_length_invalid');
    // Include the committed newline, not the next 64 KiB of unrelated records.
    const raw = Buffer.alloc(length! + 1);
    let position = 0;
    while (position < raw.length)
      position += read(handle, raw.subarray(position), offset + position);
    if (raw[length!] !== 10) throw Error('canonical_record_uncommitted');
    const start = performance.now();
    const value: unknown = JSON.parse(raw.subarray(0, length).toString('utf8'));
    stages.decodeMs += performance.now() - start;
    return object(value);
  }
  function identity(
    event: ObjectValue,
    id: string,
    bodyHash: string,
    source: string,
    offset: number,
    length?: number,
    canonicalEvent = event,
  ): { variant: number; projection: boolean } {
    return output(() => {
      const key = hash(id),
        path = indexDirectory + '/' + key.slice(0, 3);
      const handle = fs.openSync(
        path,
        fs.constants.O_CREAT |
          fs.constants.O_APPEND |
          fs.constants.O_RDWR |
          (fs.constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      try {
        const size = fs.fstatSync(handle).size;
        if (size > ENTRY_MAX) throw Error('identity_partition_budget');
        const raw = Buffer.alloc(size);
        let read = 0;
        while (read < size) {
          const n = fs.readSync(handle, raw, read, size - read, read);
          if (!n) throw Error('identity_short_read');
          read += n;
        }
        const lines = raw.toString('ascii').split('\n');
        const tuple = hash(JSON.stringify([id, event.producerRunId, event.sequence]));
        const hasTuple =
          typeof event.producerRunId === 'string' && Number.isSafeInteger(event.sequence);
        if (
          event.schema === 'mizar-diagnostic-event/2' &&
          object(event.projection).sourceEventId === id &&
          object(event.projection).policyVersion === 2 &&
          hasTuple
        ) {
          const prefix = 'C:' + key + ':' + tuple + ':';
          for (const line of lines)
            if (line.startsWith(prefix)) {
              const locator = JSON.parse(line.slice(prefix.length)) as Locator;
              try {
                if (sourceCoversProjection(readCanonical(locator), event))
                  return { variant: 0, projection: true };
              } catch (error) {
                // A failed source re-read cannot prove equivalence. Keep the wire body as a variant.
                gaps.push({
                  source: locator.source,
                  offset: locator.offset,
                  reason: String(error),
                  scope: 'projection equivalence unconfirmed',
                });
              }
            }
        }
        let variant = 0;
        for (const line of lines)
          if (line.startsWith(key + ':')) {
            if (line === key + ':' + bodyHash) return { variant: -1, projection: false };
            variant++;
          }
        const canonical =
          event.schema === 'mizar-diagnostic-event/2' && event.projection == null && hasTuple;
        const locator: Locator = { source, offset, ...(length === undefined ? {} : { length }) };
        if (canonical && source.endsWith('.gz')) {
          // Preserve every field consulted by sourceCoversProjection, including
          // complete evidence/scope. Unknown or differing wire facts stay variants.
          const fact = Buffer.from(
            JSON.stringify(
              Object.fromEntries(
                [
                  'schema',
                  'eventId',
                  'producerKind',
                  'producerRunId',
                  'sequence',
                  'kind',
                  'evidence',
                  'scope',
                  'phase',
                  'outcome',
                  'taskId',
                  'operationId',
                  'parentOperationId',
                  'attemptId',
                  'monotonicMs',
                  'sourceInterval',
                  'appVersion',
                  'coverage',
                  'observedAt',
                  'recordedAt',
                ].map((key) => [key, canonicalEvent[key]]),
              ),
            ) + '\n',
          );
          if (fact.length > ENTRY_MAX) throw Error('canonical_fact_budget');
          if (indexBytes + totalBytes + fact.length > budget) throw Error('export_disk_budget');
          factsFd ??= fs.openSync(indexDirectory + '/canonical-facts', 'wx+', 0o600);
          locator.facts = { offset: factsBytes, length: fact.length - 1 };
          writeAll(factsFd, fact);
          factsBytes += fact.length;
          indexBytes += fact.length;
        }
        const record =
          key +
          ':' +
          bodyHash +
          '\n' +
          (canonical ? 'C:' + key + ':' + tuple + ':' + JSON.stringify(locator) + '\n' : '');
        if (indexBytes + totalBytes + record.length > budget) throw Error('export_disk_budget');
        writeAll(handle, Buffer.from(record));
        indexBytes += record.length;
        return { variant, projection: false };
      } finally {
        fs.closeSync(handle);
      }
    });
  }
  function add(name: string, data: Buffer, metadata = false) {
    if (
      !/^[-a-zA-Z0-9_/.]+$/.test(name) ||
      name.startsWith('/') ||
      name.split('/').some((segment) => segment === '..' || segment === '')
    )
      throw new OutputFailure('unsafe_entry_name');
    if (data.length > ENTRY_MAX) throw new OutputFailure('export_entry_budget');
    if (
      !metadata &&
      (bytes + data.length * 1.02 + 262144 > MAX ||
        expandedBytes + data.length + FINAL_METADATA_RESERVE > EXPANDED_MAX)
    ) {
      finish(false);
      begin();
    }
    if (expandedBytes + data.length > EXPANDED_MAX)
      throw new OutputFailure('export_expanded_part_budget');
    const start = performance.now();
    output(() => {
      const file = new ZipDeflate(name, { level: 6 });
      zip.add(file);
      file.push(data, true);
    });
    stages.encodeMs += performance.now() - start;
    expandedBytes += data.length;
    entries.push({ name, bytes: data.length, sha256: hash(data) });
    sample();
  }
  function begin() {
    if (part >= 32) throw new OutputFailure('export_part_count_budget');
    part++;
    bytes = 0;
    expandedBytes = 0;
    entries = [];
    digest = createHash('sha256');
    fd = output(() => fs.openSync(d.output + '/part-' + part + '.zip.partial', 'wx', 0o600));
    zip = new Zip((error, data) =>
      output(() => {
        if (error) throw error;
        if (bytes + data.length > MAX || totalBytes + indexBytes + data.length > budget)
          throw Error('export_disk_budget');
        writeAll(fd!, data);
        digest.update(data);
        bytes += data.length;
        totalBytes += data.length;
      }),
    );
  }
  function measurements() {
    sample();
    const elapsedMs = performance.now() - started;
    return {
      collectionMs: d.collectionMs ?? null,
      elapsedMs,
      stages: {
        ...stages,
        processMs: Math.max(
          0,
          elapsedMs - Object.values(stages).reduce((sum, value) => sum + value, 0),
        ),
      },
      memory: {
        baseline,
        peakHeapUsedDelta: peakHeap - baseline.heapUsed,
        peakExternalDelta: peakExternal - baseline.external,
        peakProcessRssDelta: peakRss - baseline.rss,
        scope:
          'worker boundary samples; RSS includes main thread and other workers; not an isolated process peak',
      },
    };
  }
  function finish(final: boolean) {
    const start = performance.now(),
      encodedBefore = stages.encodeMs;
    // Final facts are written once, at the end. No circular digest and no recompression.
    add(
      'bundle.json',
      Buffer.from(
        JSON.stringify({
          schema: 'mizar-support-bundle/2',
          bundleId: d.exportId,
          partIndex: part,
          partCount: final ? part : null,
          complete: final,
          completenessScope: 'archive parts only; source coverage is declared in coverage.json',
          range: d.range,
          snapshot: redact({
            asOf: object(d.snapshot).asOf,
            atomic: false,
            sources: object(d.snapshot).sources,
            unknown: object(d.snapshot).unknown,
          }),
        }),
      ),
      true,
    );
    add(
      'measurements.json',
      Buffer.from(
        JSON.stringify({
          schema: 'mizar-support-measurements/1',
          exportId: d.exportId,
          partIndex: part,
          cutoff: {
            at: new Date().toISOString(),
            phase: 'before-measurements-coverage-and-part-close',
            scope: final ? 'all sources processed' : 'cumulative through this part',
            excluded: [
              'this measurement and coverage encoding',
              'this part close and fsync',
              'save dialog and file copy',
            ],
            laterEvidence:
              'generated manifest and subsequent export/save logs correlate by exportId',
          },
          inputBytes: processedBytes,
          outputBytes: totalBytes,
          ...measurements(),
        }),
      ),
      true,
    );
    add(
      'coverage.json',
      Buffer.from(
        JSON.stringify({
          schema: 'mizar-support-coverage/2',
          uniqueEvents,
          carrierRecords,
          aggregatedOccurrences,
          gaps: redact(gaps),
          excludedSources,
          interpretation: {
            gaps: 'Missing or unconfirmed evidence; archive completion does not resolve these gaps.',
            source_not_safely_fixed:
              'No committed pin covered this source at export time; it was not read. Historical evidence is not reconstructed.',
            excludedSources:
              'Outside the current schema or declared collection scope; producer-declared-post-cutoff-segment identifies a writer-owned successor after the pinned boundary. Not counted as current evidence; originals remain at their source.',
          },
          entries,
          scope: final ? 'final cumulative coverage' : 'cumulative through this part',
        }),
      ),
      true,
    );
    output(() => {
      zip.end();
      fs.fsyncSync(fd!);
      fs.closeSync(fd!);
      fd = undefined;
      fs.renameSync(
        d.output + '/part-' + part + '.zip.partial',
        d.output + '/part-' + part + '.zip',
      );
    });
    parts.push({ name: 'part-' + part + '.zip', bytes, sha256: digest.digest('hex') });
    stages.finalizeMs += performance.now() - start - (stages.encodeMs - encodedBefore);
  }
  let chunk: string[] = [],
    chunkBytes = 0,
    chunkIndex = 0;
  const journey: ObjectValue[] = [],
    business: ObjectValue[] = [],
    carriers: ObjectValue[] = [];
  const journeyParts: ObjectValue[] = [],
    businessParts: ObjectValue[] = [],
    carrierParts: ObjectValue[] = [];
  function flush() {
    if (!chunk.length) return;
    add('events/' + ++chunkIndex + '.ndjson', Buffer.from(chunk.join('')));
    chunk = [];
    chunkBytes = 0;
  }
  function index(name: string, records: ObjectValue[], refs: ObjectValue[]) {
    if (!records.length) return;
    const file = 'indexes/' + name + '-' + (refs.length + 1) + '.json';
    add(file, Buffer.from(JSON.stringify(records)));
    refs.push({ partIndex: part, name: file });
    records.length = 0;
  }
  function emit(
    input: unknown,
    source: string,
    offset: number,
    length?: number,
    canonicalEvent?: ObjectValue,
  ): boolean {
    carrierRecords++;
    const event =
      input !== null && typeof input === 'object' && !Array.isArray(input)
        ? object(input)
        : { evidence: input };
    if ((event.kind ?? event.stage) === 'cs2_console_records') {
      let detail = object(event.evidence);
      if (!event.evidence && typeof event.detail === 'string') {
        try {
          detail = object(JSON.parse(event.detail));
        } catch {
          /* Retain unknown content. */
        }
      }
      if (Array.isArray(detail.records)) {
        const refs: string[] = [];
        for (const value of detail.records) {
          const record = object(value);
          const at = typeof record.sourceOffset === 'number' ? record.sourceOffset : offset;
          const id =
            typeof record.sourceRecordId === 'string'
              ? record.sourceRecordId
              : 'legacy:' + hash(source + ':' + at);
          if (
            emit(
              {
                ...record,
                eventId: id,
                producerRunId: event.producerRunId ?? event.startupSessionId,
                kind: 'cs2_console_observation',
                observedAt: record.capturedAt,
                sourceInterval: {
                  from: record.sourceAfterUtc ?? null,
                  to: record.lastCapturedAt ?? record.capturedAt ?? null,
                },
                evidence: record,
              },
              source,
              at,
            )
          )
            refs.push(id);
        }
        const { detail: ignored, ...header } = event;
        void ignored;
        return emit(
          {
            ...header,
            kind: 'console_carrier_reference',
            stage: 'console_carrier_reference',
            sourceInterval: { from: null, to: null },
            evidence: {
              eventRefs: refs,
              rangeExcludedChildren: detail.records.length - refs.length,
            },
          },
          source,
          offset,
          length,
          event,
        );
      }
    }
    const stamp = event.observedAt ?? event.time ?? event.recordedAt;
    let interval = event.sourceInterval;
    if (!interval && Array.isArray(object(event.evidence).samples)) {
      const times = (object(event.evidence).samples as unknown[])
        .map((sample) => object(sample).time)
        .filter((time): time is string => Number.isFinite(timestamp(time)))
        .sort((a, b) => timestamp(a) - timestamp(b));
      if (times.length) interval = { from: times[0], to: times.at(-1) };
    }
    const from = timestamp(interval ? object(interval).from : stamp),
      to = timestamp(interval ? object(interval).to : stamp);
    if (
      (d.range.from && Number.isFinite(to) && to < timestamp(d.range.from)) ||
      (d.range.to && Number.isFinite(from) && from > timestamp(d.range.to))
    )
      return false;
    const id =
      typeof event.eventId === 'string'
        ? event.eventId
        : typeof event.id === 'string' && object(event.source).recordSequence
          ? event.id
          : typeof event.startupSessionId === 'string' && Number.isSafeInteger(event.sequence)
            ? event.startupSessionId + ':' + event.sequence
            : 'legacy:' + hash(source + ':' + offset);
    const { variant, projection } = identity(
      event,
      id,
      hash(JSON.stringify(event)),
      source,
      offset,
      length,
      canonicalEvent ?? event,
    );
    if (projection || variant < 0) {
      carriers.push({
        eventId: id,
        producerRunId: event.producerRunId,
        sequence: event.sequence,
        source,
        offset,
        role: projection ? 'technical-projection-reference' : 'identical-carrier-reference',
      });
      if (carriers.length >= 2000) index('carriers', carriers, carrierParts);
      return true;
    }
    if (!variant) {
      uniqueEvents++;
      const occurrences = event.occurrences ?? object(event.coverage).occurrences;
      aggregatedOccurrences +=
        typeof occurrences === 'number' && Number.isFinite(occurrences) && occurrences > 0
          ? occurrences
          : 1;
    }
    const line =
      JSON.stringify({
        ...object(redact(event)),
        eventId: id,
        carrier: {
          source,
          offset,
          role:
            event.projection != null || source.startsWith('diagnostic-outbox/')
              ? 'technical-copy'
              : 'local-original',
        },
        ...(variant ? { variant, variantReason: 'nonidentical-carrier-preserved' } : {}),
      }) + '\n';
    const size = Buffer.byteLength(line);
    if (size > ENTRY_MAX) throw Error('record_exceeds_entry_budget');
    if (chunkBytes + size > 1024 * 1024) flush();
    chunk.push(line);
    chunkBytes += size;
    const ref = {
      eventId: id,
      variant,
      kind: event.kind ?? event.stage ?? null,
      taskId: event.taskId ?? null,
      operationId: event.operationId ?? null,
    };
    if (ref.taskId || ref.operationId) journey.push(ref);
    if (String(ref.kind).startsWith('business')) business.push(ref);
    if (journey.length >= 2000) index('journey', journey, journeyParts);
    if (business.length >= 2000) index('business', business, businessParts);
    sample();
    return true;
  }
  function read(handle: number, raw: Buffer, position: number) {
    const start = performance.now();
    const n = fs.readSync(handle, raw, 0, raw.length, position);
    stages.readMs += performance.now() - start;
    processedBytes += n;
    if (!n) throw Error('snapshot_short_read');
    return n;
  }
  let failed = false,
    indexCreated = false,
    primaryError: unknown;
  try {
    output(() => fs.mkdirSync(indexDirectory, { mode: 0o700 }));
    indexCreated = true;
    begin();
    for (const source of d.sources) {
      report({ phase: 'encoding', inputBytes: processedBytes, outputBytes: totalBytes });
      try {
        if (!Number.isSafeInteger(source.bytes) || source.bytes < 0)
          throw Error('invalid_source_size');
        if (source.rawIndex || source.name.endsWith('.gz')) {
          if (source.bytes > (source.rawIndex ? ENTRY_MAX : 16 * 1024 * 1024))
            throw Error('source_decode_budget');
          let value: unknown;
          if (source.rawIndex) {
            const raw = Buffer.alloc(source.bytes);
            let position = 0;
            while (position < raw.length)
              position += read(source.fd, raw.subarray(position), position);
            const start = performance.now();
            value = JSON.parse(raw.toString('utf8'));
            stages.decodeMs += performance.now() - start;
          } else value = readGzip(source);
          if (source.rawIndex)
            add('indexes/' + source.name, Buffer.from(JSON.stringify(redact(value))));
          else {
            const events = Array.isArray(value)
              ? value
              : object(value).schema === 'mizar-technical-diagnostics/1' &&
                  Array.isArray(object(value).events)
                ? (object(value).events as unknown[])
                : null;
            if (
              events &&
              events.every((event) => object(event).schema === 'mizar-diagnostic-event/2')
            )
              events.forEach((event, i) => emit(event, source.name, i));
            else
              excludedSources.push({
                source: source.name,
                reason: 'outside-current-event-schema; original retained',
              });
          }
        } else if (source.name.endsWith('.json')) throw Error('unsupported_current_source');
        else {
          const decoder = new StringDecoder('utf8');
          let tail = '',
            position = 0,
            offset = 0,
            body = '',
            attachmentIndex = 0;
          const write = (line: string) => {
            if (source.rawAttachment) {
              for (const secret of source.secrets ?? [])
                if (secret) line = line.split(secret).join('[redacted]');
              line = String(redact(line)) + '\n';
              if (Buffer.byteLength(body) + Buffer.byteLength(line) > 1024 * 1024 && body) {
                add(source.name + '-' + ++attachmentIndex + '.log', Buffer.from(body));
                body = '';
              }
              body += line;
            } else if (line) {
              let value: unknown;
              const start = performance.now();
              try {
                value = JSON.parse(line);
              } catch {
                value = {
                  evidence: { text: line },
                  coverage: { unknown: ['unstructured-source-time'] },
                };
              }
              stages.decodeMs += performance.now() - start;
              emit(value, source.name, offset, Buffer.byteLength(line));
            }
          };
          while (position < source.bytes) {
            const raw = Buffer.alloc(Math.min(65536, source.bytes - position));
            const n = read(source.fd, raw, position);
            position += n;
            const lines = (tail + decoder.write(raw.subarray(0, n))).split('\n');
            tail = lines.pop()!;
            if (Buffer.byteLength(tail) > ENTRY_MAX) throw Error('source_line_budget');
            for (const line of lines) {
              if (Buffer.byteLength(line) > ENTRY_MAX) throw Error('source_line_budget');
              write(line);
              offset += Buffer.byteLength(line) + 1;
            }
          }
          tail += decoder.end();
          if (source.rawAttachment) {
            if (tail) write(tail);
            if (body) add(source.name + '-' + ++attachmentIndex + '.log', Buffer.from(body));
          } else if (tail)
            gaps.push({ source: source.name, offset, reason: 'uncommitted_partial_line' });
        }
      } catch (error) {
        if (error instanceof OutputFailure) throw error;
        gaps.push({
          source: source.name,
          reason: String(error),
          scope: 'remaining source not decoded; original retained',
        });
      }
    }
    flush();
    for (const [name, records, refs] of [
      ['journey', journey, journeyParts],
      ['business', business, businessParts],
      ['carriers', carriers, carrierParts],
    ] as const)
      add(
        'indexes/' + name + '.json',
        Buffer.from(
          JSON.stringify({ schema: 'mizar-reference-index/2', parts: refs, tail: records }),
        ),
      );
    add('snapshots/current.json', Buffer.from(JSON.stringify(redact(d.snapshot))));
    finish(true);
  } catch (error) {
    failed = true;
    primaryError = error;
  }
  // A completed archive is independent of temporary-index cleanup. Attempt
  // each close/removal even if another fails, without replacing the build error.
  const cleanupFailures: Error[] = [];
  const cleanup = (reason: string, action: () => void) => {
    try {
      action();
    } catch (cause) {
      cleanupFailures.push(new Error(reason, { cause }));
    }
  };
  if (fd !== undefined) cleanup('export_output_close_failed', () => fs.closeSync(fd!));
  if (factsFd !== undefined)
    cleanup('export_identity_facts_close_failed', () => fs.closeSync(factsFd!));
  if (indexCreated)
    cleanup('export_identity_index_remove_failed', () =>
      fs.rmSync(indexDirectory, { recursive: true, force: true }),
    );
  const secrets = d.sources.flatMap((source) => source.secrets ?? []);
  const diagnostics = {
    cleanupFailures: diagnosticValue(cleanupFailures, '', new Set(), secrets),
  };
  if (failed)
    report({
      phase: 'failed',
      error: diagnosticValue(String(primaryError), '', new Set(), secrets),
      diagnostic: diagnosticValue(primaryError, '', new Set(), secrets),
      ...diagnostics,
    });
  else
    report({
      phase: 'ready',
      knownGaps: gaps.length,
      completeKnownSources: gaps.length === 0,
      parts,
      uniqueEvents,
      carrierRecords,
      aggregatedOccurrences,
      gaps: redact(gaps),
      excludedSources,
      inputBytes: processedBytes,
      outputBytes: totalBytes,
      measurements: measurements(),
      ...diagnostics,
    });
}
