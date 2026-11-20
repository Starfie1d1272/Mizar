import { diagnosticEvidence as redact } from './diagnostic-evidence.js';
import { diagnosticValue } from './diagnostic-value.js';
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
    jsonAttachment?: boolean;
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
const ENTRY_MAX = 2 * 1024 * 1024;
// Same aggregate expanded budget as the former 32-part archive.
const EXPANDED_MAX = 8 * 1024 * 1024 * 1024;
const MAX_ENTRIES = 65_534;
const timestamp = (value: unknown) => (typeof value === 'string' ? Date.parse(value) : NaN);
class OutputFailure extends Error {}
/** Synchronous, bounded work in one finite-lifetime worker; descriptors are pinned by the owner. */
export function runArchiveWorker(
  d: ArchiveWorkerData,
  report: (message: ObjectValue) => void,
): void {
  let zip: Zip,
    fd: number | undefined,
    entryCount = 0,
    expandedBytes = 0,
    totalBytes = 0;
  const digest = createHash('sha256');
  const entries: { name: string; bytes: number; sha256: string }[] = [];
  const gaps = [...d.gaps];
  const excludedSources: { source: string; reason: string }[] = [...(d.excludedSources ?? [])];
  const coverageFiles: { partIndex: number; name: string }[] = [];
  // Keep space for the entry index and other final metadata even with a large inventory.
  const inlineCoverageLimit = ENTRY_MAX / 4;
  function inlineCoverage() {
    return Buffer.byteLength(JSON.stringify([gaps, excludedSources])) <= inlineCoverageLimit;
  }
  let carrierRecords = 0,
    retainedRecords = 0,
    aggregatedOccurrences = 0,
    processedBytes = 0;
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
  function add(name: string, data: Buffer) {
    if (
      !/^[-a-zA-Z0-9_/.]+$/.test(name) ||
      name.startsWith('/') ||
      name.split('/').some((segment) => segment === '..' || segment === '')
    )
      throw new OutputFailure('unsafe_entry_name');
    if (data.length > ENTRY_MAX) throw new OutputFailure('export_entry_budget');
    if (expandedBytes + data.length > EXPANDED_MAX || entryCount >= MAX_ENTRIES)
      throw new OutputFailure('export_zip_budget');
    const start = performance.now();
    output(() => {
      const file = new ZipDeflate(name, { level: 1 });
      zip.add(file);
      file.push(data, true);
    });
    stages.encodeMs += performance.now() - start;
    expandedBytes += data.length;
    entryCount++;
    entries.push({ name, bytes: data.length, sha256: hash(data) });
    sample();
  }
  function begin() {
    fd = output(() => fs.openSync(d.output + '/part-1.zip.partial', 'wx', 0o600));
    zip = new Zip((error, data) =>
      output(() => {
        if (error) throw error;
        if (totalBytes + data.length > budget) throw Error('export_disk_budget');
        writeAll(fd!, data);
        digest.update(data);
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
  function finish() {
    const start = performance.now(),
      encodedBefore = stages.encodeMs;
    // Final facts are written once, at the end. No circular digest and no recompression.
    add(
      'bundle.json',
      Buffer.from(
        JSON.stringify({
          schema: 'mizar-support-bundle/3',
          bundleId: d.exportId,
          partIndex: 1,
          partCount: 1,
          complete: true,
          completenessScope: 'archive file only; source coverage is declared in coverage.json',
          range: d.range,
          snapshot: redact({
            asOf: object(d.snapshot).asOf,
            atomic: false,
            sources: object(d.snapshot).sources,
            unknown: object(d.snapshot).unknown,
          }),
        }),
      ),
    );
    add(
      'measurements.json',
      Buffer.from(
        JSON.stringify({
          schema: 'mizar-support-measurements/1',
          exportId: d.exportId,
          partIndex: 1,
          cutoff: {
            at: new Date().toISOString(),
            phase: 'before-measurements-coverage-and-archive-close',
            scope: 'all sources processed',
            excluded: [
              'this measurement and coverage encoding',
              'ZIP close and fsync',
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
    );
    const inline = inlineCoverage();
    add(
      'coverage.json',
      Buffer.from(
        JSON.stringify({
          schema: 'mizar-support-coverage/2',
          retainedRecords,
          carrierRecords,
          aggregatedOccurrences,
          gaps: inline ? redact(gaps) : [],
          excludedSources: inline ? excludedSources : [],
          ...(inline
            ? {}
            : {
                gapCount: gaps.length,
                excludedSourceCount: excludedSources.length,
                coverageFiles,
              }),
          interpretation: {
            gaps: 'Missing or unconfirmed evidence; archive completion does not resolve these gaps.',
            excludedSources:
              'Outside the supported schema or requested range; originals remain at their source.',
          },
          entries,
          scope: 'final cumulative coverage',
        }),
      ),
    );
    output(() => {
      zip.end();
      fs.fsyncSync(fd!);
      fs.closeSync(fd!);
      fd = undefined;
      fs.renameSync(d.output + '/part-1.zip.partial', d.output + '/part-1.zip');
    });
  }
  let chunk: string[] = [],
    chunkBytes = 0,
    chunkIndex = 0;
  function flush() {
    if (!chunk.length) return;
    add('events/' + ++chunkIndex + '.ndjson', Buffer.from(chunk.join('')));
    chunk = [];
    chunkBytes = 0;
  }
  function writeCoverageFiles() {
    if (inlineCoverage()) return;
    let lines: string[] = [];
    let bytes = 0;
    const flushCoverage = () => {
      if (!lines.length) return;
      const name = 'coverage/details-' + (coverageFiles.length + 1) + '.ndjson';
      add(name, Buffer.from(lines.join('')));
      coverageFiles.push({ partIndex: 1, name });
      lines = [];
      bytes = 0;
    };
    for (const [kind, values] of [
      ['gap', gaps],
      ['excluded', excludedSources],
    ] as const) {
      for (const value of values) {
        const line = JSON.stringify({ kind, value: redact(value) }) + '\n';
        const size = Buffer.byteLength(line);
        if (size > ENTRY_MAX) {
          lines.push(
            JSON.stringify({ kind, value: { reason: 'coverage_record_oversize', bytes: size } }) +
              '\n',
          );
          bytes += Buffer.byteLength(lines.at(-1)!);
          if (bytes >= ENTRY_MAX / 2) flushCoverage();
          continue;
        }
        if (bytes + size > ENTRY_MAX / 2) flushCoverage();
        lines.push(line);
        bytes += size;
      }
    }
    flushCoverage();
  }
  function emit(input: unknown, source: string, offset: number): boolean {
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
        const { records: ignoredRecords, ...context } = detail;
        void ignored;
        void ignoredRecords;
        return emit(
          {
            ...header,
            kind: 'console_carrier_reference',
            stage: 'console_carrier_reference',
            sourceInterval: { from: null, to: null },
            evidence: {
              ...context,
              eventRefs: refs,
              rangeExcludedChildren: detail.records.length - refs.length,
            },
          },
          source,
          offset,
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
    retainedRecords++;
    const evidence = object(event.evidence);
    const stderr = object(evidence.stderr);
    if (event.kind === 'native_diagnostic_coverage_gap' && Number(evidence.dropped) > 0)
      gaps.push({
        source,
        eventId: id,
        reason: 'native_event_loss_reported',
        dropped: evidence.dropped,
        scope: 'Host reported missing records in the selected interval',
      });
    if (event.kind === 'observer_attempt_terminal' && stderr.truncated === true)
      gaps.push({
        source,
        eventId: id,
        reason: 'observer_stderr_budget',
        observedBytes: stderr.observedBytes,
        retainedBytes: stderr.retainedBytes,
        scope: 'redacted stderr prefix retained; remaining bytes were not collected',
      });
    const occurrences = event.occurrences ?? object(event.coverage).occurrences;
    aggregatedOccurrences +=
      typeof occurrences === 'number' && Number.isFinite(occurrences) && occurrences > 0
        ? occurrences
        : 1;
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
      }) + '\n';
    const size = Buffer.byteLength(line);
    if (size > ENTRY_MAX) throw Error('record_exceeds_entry_budget');
    if (chunkBytes + size > 1024 * 1024) flush();
    chunk.push(line);
    chunkBytes += size;
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
    primaryError: unknown;
  try {
    begin();
    for (const source of d.sources) {
      report({ phase: 'encoding', inputBytes: processedBytes, outputBytes: totalBytes });
      try {
        if (!Number.isSafeInteger(source.bytes) || source.bytes < 0)
          throw Error('invalid_source_size');
        if (source.rawIndex || source.jsonAttachment || source.name.endsWith('.gz')) {
          if (
            source.bytes >
            (source.jsonAttachment ? 128 * 1024 : source.rawIndex ? ENTRY_MAX : 16 * 1024 * 1024)
          )
            throw Error('source_decode_budget');
          let value: unknown;
          if (source.rawIndex || source.jsonAttachment) {
            const raw = Buffer.alloc(source.bytes);
            let position = 0;
            while (position < raw.length)
              position += read(source.fd, raw.subarray(position), position);
            const start = performance.now();
            value = JSON.parse(raw.toString('utf8'));
            stages.decodeMs += performance.now() - start;
          } else value = readGzip(source);
          if (source.jsonAttachment) {
            if (
              !['cs2-observer-report/1', 'cs2-observer-report/2'].includes(
                String(object(value).schema),
              )
            )
              throw Error('observer_report_schema');
            add(source.name, Buffer.from(JSON.stringify(redact(value))));
          } else if (source.rawIndex)
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
            bodyBytes = 0,
            attachmentIndex = 0;
          const write = (line: string) => {
            if (source.rawAttachment) {
              for (const secret of source.secrets ?? [])
                if (secret) line = line.split(secret).join('[redacted]');
              line = String(redact(line)) + '\n';
              const lineBytes = Buffer.byteLength(line);
              if (lineBytes > ENTRY_MAX) {
                gaps.push({
                  source: source.name,
                  offset,
                  reason: 'attachment_line_budget',
                  bytes: lineBytes,
                });
                return;
              }
              if (bodyBytes + lineBytes > 1024 * 1024 && body) {
                add(source.name + '-' + ++attachmentIndex + '.log', Buffer.from(body));
                body = '';
                bodyBytes = 0;
              }
              body += line;
              bodyBytes += lineBytes;
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
              emit(value, source.name, offset);
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
    const snapshot = Buffer.from(JSON.stringify(redact(d.snapshot)));
    if (snapshot.length <= ENTRY_MAX) add('snapshots/current.json', snapshot);
    else
      gaps.push({
        source: 'snapshots/current.json',
        reason: 'snapshot_entry_budget',
        bytes: snapshot.length,
      });
    writeCoverageFiles();
    finish();
  } catch (error) {
    failed = true;
    primaryError = error;
  }
  // A completed archive is independent of output-handle cleanup. Attempt
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
      parts: [{ name: 'part-1.zip', bytes: totalBytes, sha256: digest.digest('hex') }],
      retainedRecords,
      carrierRecords,
      aggregatedOccurrences,
      gaps: inlineCoverage() ? redact(gaps) : [],
      excludedSources: inlineCoverage() ? excludedSources : [],
      ...(coverageFiles.length
        ? { coverageFiles, excludedSourceCount: excludedSources.length }
        : {}),
      inputBytes: processedBytes,
      outputBytes: totalBytes,
      measurements: measurements(),
      ...diagnostics,
    });
}
