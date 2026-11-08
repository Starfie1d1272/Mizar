import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { crc32, inflateRawSync } from 'node:zlib';
import { dirname, join } from 'node:path';

// Read locally; never upload or execute bundle content. Redirect stdout to retain the full timeline.
const path = process.argv[2];
if (!path)
  throw new Error(
    'Usage: node scripts/diagnostics/read-support-bundle.mjs part-1.zip|generated.json > timeline.ndjson',
  );
if ((await stat(path)).size > 256 * 1024 * 1024) throw new Error('Bundle exceeds transport budget');
const input = await readFile(path);
if (input[0] === 0x50 && input[1] === 0x4b) {
  await readZip(input, path);
  process.exit(0);
}
const bundle = JSON.parse(input.toString('utf8'));
if (bundle.schema === 'mizar-support-export/2') {
  if (
    typeof bundle.exportId !== 'string' ||
    !bundle.exportId ||
    !Array.isArray(bundle.parts) ||
    !bundle.parts.length ||
    bundle.parts.length > 32
  )
    throw new Error('Invalid total manifest');
  if (bundle.parts.reduce((sum, part) => sum + part.bytes, 0) > 256 * 1024 * 1024)
    throw new Error('Export exceeds transport budget');
  // Validate every part before emitting any timeline: a missing later part is not partial success.
  for (let index = 0; index < bundle.parts.length; index++) {
    const part = bundle.parts[index];
    if (part.name !== `part-${index + 1}.zip`) throw new Error('Invalid part name');
    const file = join(dirname(path), part.name);
    if ((await stat(file)).size !== part.bytes)
      throw new Error(`Missing or changed part: ${part.name}`);
    const bytes = await readFile(file);
    if (createHash('sha256').update(bytes).digest('hex') !== part.sha256)
      throw new Error(`Part checksum mismatch: ${part.name}`);
    await readZip(bytes, file, bundle.exportId, index + 1, bundle.parts.length, false);
  }
  for (let index = 0; index < bundle.parts.length; index++) {
    const file = join(dirname(path), bundle.parts[index].name);
    const bytes = await readFile(file);
    if (createHash('sha256').update(bytes).digest('hex') !== bundle.parts[index].sha256)
      throw new Error('Part changed during read');
    await readZip(bytes, file, bundle.exportId, index + 1, bundle.parts.length);
  }
  process.exit(0);
}
throw new Error('Unsupported support export; expected a current ZIP or generated manifest');
async function readZip(bytes, source, bundleId, partIndex, partCount = 1, emit = true) {
  if (bytes.length > 18_874_368) throw new Error('ZIP exceeds part budget');
  let end = -1;
  for (let n = bytes.length - 22; n >= Math.max(0, bytes.length - 65557); n--)
    if (bytes.readUInt32LE(n) === 0x06054b50) {
      end = n;
      break;
    }
  if (end < 0) throw new Error('ZIP directory missing');
  if (
    bytes.readUInt16LE(end + 4) ||
    bytes.readUInt16LE(end + 6) ||
    bytes.readUInt16LE(end + 8) !== bytes.readUInt16LE(end + 10) ||
    end + 22 + bytes.readUInt16LE(end + 20) !== bytes.length
  )
    throw new Error('Invalid ZIP end');
  const count = bytes.readUInt16LE(end + 10);
  const directoryStart = bytes.readUInt32LE(end + 16);
  if (directoryStart + bytes.readUInt32LE(end + 12) !== end)
    throw new Error('Invalid ZIP directory size');
  let offset = bytes.readUInt32LE(end + 16),
    expanded = 0;
  const entries = new Map();
  for (let index = 0; index < count; index++) {
    if (offset + 46 > bytes.length || bytes.readUInt32LE(offset) !== 0x02014b50)
      throw new Error('Invalid ZIP directory');
    const method = bytes.readUInt16LE(offset + 10),
      checksum = bytes.readUInt32LE(offset + 16),
      compressed = bytes.readUInt32LE(offset + 20),
      size = bytes.readUInt32LE(offset + 24),
      nameLength = bytes.readUInt16LE(offset + 28),
      extra = bytes.readUInt16LE(offset + 30),
      comment = bytes.readUInt16LE(offset + 32),
      local = bytes.readUInt32LE(offset + 42);
    const name = bytes.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    offset += 46 + nameLength + extra + comment;
    if (
      size > 2 * 1024 * 1024 ||
      (expanded += size) > 256 * 1024 * 1024 ||
      entries.has(name) ||
      name.startsWith('/') ||
      name.split('/').some((segment) => !segment) ||
      offset > end ||
      bytes.readUInt16LE(offset - 46 - nameLength - extra - comment + 8) & 1 ||
      !/^[-a-zA-Z0-9_/.]+$/.test(name) ||
      name.includes('..')
    )
      throw new Error('Unsafe ZIP entry');
    if (local + 30 > bytes.length || bytes.readUInt32LE(local) !== 0x04034b50)
      throw new Error('Invalid ZIP entry header');
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    if (
      start + compressed > directoryStart ||
      bytes.readUInt16LE(local + 8) !== method ||
      bytes.subarray(local + 30, local + 30 + bytes.readUInt16LE(local + 26)).toString('utf8') !==
        name
    )
      throw new Error('Incomplete ZIP entry');
    const data =
      method === 0
        ? bytes.subarray(start, start + compressed)
        : method === 8
          ? inflateRawSync(bytes.subarray(start, start + compressed), {
              maxOutputLength: 2 * 1024 * 1024,
            })
          : null;
    if (!data || data.length !== size) throw new Error('ZIP entry size mismatch');
    // Coverage cannot carry its own SHA; CRC validates every entry, including this metadata.
    if (crc32(data) !== checksum) throw new Error(`ZIP entry CRC mismatch: ${name}`);
    entries.set(name, data);
  }
  if (offset !== end) throw new Error('ZIP directory count mismatch');
  const metadata = JSON.parse(entries.get('bundle.json')?.toString('utf8') ?? 'null');
  if (
    metadata?.schema !== 'mizar-support-bundle/2' ||
    typeof metadata.bundleId !== 'string' ||
    !metadata.bundleId ||
    (bundleId && metadata.bundleId !== bundleId) ||
    (partIndex && metadata.partIndex !== partIndex)
  )
    throw new Error('ZIP bundle identity mismatch');
  const expectedIndex = partIndex ?? 1;
  const last = expectedIndex === partCount;
  if (
    metadata.partIndex !== expectedIndex ||
    metadata.complete !== last ||
    metadata.partCount !== (last ? partCount : null)
  )
    throw new Error(
      'Incomplete ZIP set: final metadata requires the total manifest and every listed part',
    );
  const coverage = JSON.parse(entries.get('coverage.json')?.toString('utf8') ?? 'null');
  if (
    coverage?.schema !== 'mizar-support-coverage/2' ||
    !Array.isArray(coverage.entries) ||
    !Array.isArray(coverage.gaps)
  )
    throw new Error('Missing final coverage');
  const indexed = new Set();
  for (const entry of coverage?.entries ?? []) {
    if (indexed.has(entry.name) || entry.name === 'coverage.json')
      throw new Error('Invalid entry index');
    indexed.add(entry.name);
    const data = entries.get(entry.name);
    if (
      !data ||
      data.length !== entry.bytes ||
      createHash('sha256').update(data).digest('hex') !== entry.sha256
    )
      throw new Error('ZIP entry digest mismatch');
  }
  if (
    indexed.size !== entries.size - 1 ||
    [...entries.keys()].some((name) => name !== 'coverage.json' && !indexed.has(name))
  )
    throw new Error('Unindexed ZIP entry');
  if (!emit) return;
  for (const [name, data] of entries)
    if (name.startsWith('events/') && name.endsWith('.ndjson'))
      for (const line of data.toString('utf8').split('\n'))
        if (line) {
          JSON.parse(line);
          if (!process.stdout.write(line + '\n'))
            await new Promise((resolve) => process.stdout.once('drain', resolve));
        }
  process.stderr.write(
    JSON.stringify({
      source,
      bundleId: metadata.bundleId,
      partIndex: metadata.partIndex,
      coverage,
    }) + '\n',
  );
}
