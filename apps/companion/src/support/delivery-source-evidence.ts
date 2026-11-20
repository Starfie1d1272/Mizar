import { isDiagnosticEvent } from '@mizar/protocol';
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  DELIVERY_LIMITS,
  decodeDiagnosticBatch,
  decompress,
  secureRead,
  sourceLines,
} from './delivery-encoding.js';
import { diagnosticSegmentNames, performanceSegmentPattern } from './segments.js';
import { technicalProjection } from './technical-projection.js';

export async function readPerformanceSource(directory: string, name: string) {
  const bytes = await secureRead(directory, name, 1536 * 1024);
  const raw = await decompress(bytes, { maxOutputLength: 1024 * 1024 });
  const records = JSON.parse(raw.toString('utf8')) as Record<string, unknown>[];
  if (
    !Array.isArray(records) ||
    records.length > DELIVERY_LIMITS.events ||
    records.some((event) => event.schema !== 'mizar-diagnostic-event/2')
  )
    throw new Error('performance_source_format');
  return records;
}

/** Only discard a wire when retained producer records reproduce every event. */
export async function findSourceEvidence(directory: string, bytes: Buffer) {
  try {
    const { events } = await decodeDiagnosticBatch(bytes);
    if (!events?.length) return null;
    const remaining = new Map<string, (typeof events)[number]>();
    for (const event of events) {
      if (!isDiagnosticEvent(event) || remaining.has(event.eventId)) return null;
      remaining.set(event.eventId, event);
    }
    const match = (source: unknown) => {
      if (!isDiagnosticEvent(source) || source.coverage?.durability !== 'committed') return;
      const event = remaining.get(source.eventId);
      if (!event) return;
      const consentAt = (event as { projection?: { consentAt?: unknown } }).projection?.consentAt;
      if (
        typeof consentAt === 'string' &&
        isDeepStrictEqual(
          technicalProjection(source as unknown as Record<string, unknown>, consentAt),
          event,
        )
      )
        remaining.delete(source.eventId);
    };
    const first = events[0];
    if (!isDiagnosticEvent(first)) return null;
    const producer = first.producerKind;
    const sources = new Map<string, Awaited<ReturnType<typeof lstat>>>();
    const stillRetained = async () => {
      for (const [path, before] of sources) {
        const current = await lstat(path).catch(() => null);
        if (
          !current ||
          current.isSymbolicLink() ||
          current.dev !== before.dev ||
          current.ino !== before.ino ||
          current.size !== before.size ||
          current.mtimeMs !== before.mtimeMs
        )
          return false;
      }
      return true;
    };
    const candidates = (await diagnosticSegmentNames(directory))
      .reverse()
      .filter(
        (name) =>
          (producer !== 'companion' || name.startsWith('session-')) &&
          (producer !== 'host' || name.startsWith('desktop-')),
      );
    let remainingBytes = DELIVERY_LIMITS.queueBytes;
    for (const name of candidates) {
      const path = join(directory, name);
      const before = await lstat(path);
      const count = remaining.size;
      for await (const line of sourceLines(directory, name)) {
        remainingBytes -= Buffer.byteLength(line) + 1;
        if (remainingBytes < 0) return null;
        if (line) match(JSON.parse(line));
        if (!remaining.size) break;
      }
      if (remaining.size < count) sources.set(path, before);
      if (!remaining.size) return (await stillRetained()) ? stillRetained : null;
    }
    if (producer !== 'companion') return null;
    const performanceDirectory = join(directory, 'performance-pending');
    for (const name of await readdir(performanceDirectory)) {
      if (!performanceSegmentPattern.test(name)) continue;
      const path = join(performanceDirectory, name);
      const before = await lstat(path);
      const count = remaining.size;
      for (const event of await readPerformanceSource(performanceDirectory, name)) {
        remainingBytes -= Buffer.byteLength(JSON.stringify(event));
        if (remainingBytes < 0) return null;
        match(event);
        if (!remaining.size) break;
      }
      if (remaining.size < count) sources.set(path, before);
      if (!remaining.size) return (await stillRetained()) ? stillRetained : null;
    }
  } catch {
    // Rotation, malformed data, or uncertain coverage keeps the wire exportable.
  }
  return null;
}
