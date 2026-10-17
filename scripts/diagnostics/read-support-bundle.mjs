import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';

// Read locally; never upload or execute bundle content. Redirect stdout to retain the full timeline.
const path = process.argv[2];
if (!path)
  throw new Error(
    'Usage: node scripts/diagnostics/read-support-bundle.mjs bundle.json > timeline.ndjson',
  );
if ((await stat(path)).size > 256 * 1024 * 1024) throw new Error('Bundle exceeds transport budget');
const bundle = JSON.parse(await readFile(path, 'utf8'));
if (bundle.schema !== 'mizar-support-bundle/1' || !Array.isArray(bundle.fullLogs?.files))
  throw new Error('Full log archive missing (legacy or invalid bundle)');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const timeline = [];
const failures = [];
const fragments = new Map();
for (const file of bundle.fullLogs.files) {
  if (!['read', 'incomplete_last_line'].includes(file.status)) {
    failures.push({ name: file.name, status: file.status });
    continue;
  }
  const parts = file.volumes.map((volume, index) => {
    if (
      volume.index !== index ||
      !Number.isInteger(volume.bytes) ||
      volume.bytes < 0 ||
      volume.bytes > 1024 * 1024
    )
      throw new Error(`Invalid/missing volume: ${file.name}/${index}`);
    const bytes = gunzipSync(Buffer.from(volume.gzipBase64, 'base64'), {
      maxOutputLength: 1024 * 1024,
    });
    if (bytes.length !== volume.bytes || hash(bytes) !== volume.sha256)
      throw new Error(`Volume integrity failure: ${file.name}/${index}`);
    return bytes;
  });
  const bytes = Buffer.concat(parts);
  if (hash(bytes) !== file.sha256) throw new Error(`File integrity failure: ${file.name}`);
  if (file.status === 'incomplete_last_line')
    failures.push({ name: file.name, status: file.status });
  if (file.name.endsWith('.json')) {
    const value = JSON.parse(bytes.toString('utf8'));
    for (const group of value.groups ?? [])
      for (const event of group.events ?? []) timeline.push({ file: file.name, ...event });
    continue;
  }
  let session = null;
  for (const line of bytes.toString('utf8').split('\n').filter(Boolean)) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      event = { stage: 'unstructured_or_partial_record', text: line };
    }
    const rawDetail = event.error ?? event.detail;
    if (typeof rawDetail === 'string') {
      try {
        const detail = JSON.parse(rawDetail);
        if (
          typeof detail.detailId === 'string' &&
          Number.isInteger(detail.part) &&
          Number.isInteger(detail.parts)
        ) {
          const group = fragments.get(detail.detailId) ?? {
            event: { file: file.name, ...event },
            expected: detail.parts,
            parts: new Map(),
          };
          group.parts.set(detail.part, detail.text);
          fragments.set(detail.detailId, group);
        }
      } catch {
        /* Non-JSON native details remain in the timeline. */
      }
    }
    session = event.startupSessionId ?? session;
    timeline.push({ file: file.name, ...event, startupSessionId: session });
  }
}
for (const [id, group] of fragments) {
  if (
    group.parts.size !== group.expected ||
    [...group.parts.keys()].some((index) => index < 1 || index > group.expected)
  ) {
    failures.push({
      detailId: id,
      status: 'missing_detail_parts',
      expected: group.expected,
      included: group.parts.size,
    });
    continue;
  }
  const text = [...group.parts.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, text]) => text)
    .join('');
  timeline.push({ ...group.event, reconstructedDetail: text, detailId: id, reconstructed: true });
}
const time = (event) => {
  const value = Date.parse(event.recordedAt ?? event.timestamp ?? event.time);
  return Number.isFinite(value) ? value : typeof event.time === 'number' ? event.time : 0;
};
timeline.sort((a, b) => time(a) - time(b) || (a.sequence ?? 0) - (b.sequence ?? 0));
for (const event of timeline) process.stdout.write(JSON.stringify(event) + '\n');
process.stderr.write(
  JSON.stringify({
    records: timeline.length,
    sessions: bundle.fullLogs.sessions,
    files: failures,
    health: bundle.sessionLogHealth,
    completeness: bundle.fullLogs.completeness,
  }) + '\n',
);
