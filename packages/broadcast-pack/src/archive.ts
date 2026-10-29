import { crc32, inflateRaw } from 'node:zlib';
import { promisify } from 'node:util';
import { PACK_LIMITS, parseManifest, verifyFiles } from './index.js';

const inflate = promisify(inflateRaw);
function requireArchive(ok: unknown): asserts ok {
  if (!ok) throw new Error('package_invalid');
}

/** Read ZIP32 into memory without extracting paths or granting content authority. */
export async function readPackArchive(zip: Buffer) {
  requireArchive(zip.length >= 22 && zip.length <= PACK_LIMITS.total);
  let end = zip.length - 22;
  while (end >= Math.max(0, zip.length - 65557) && zip.readUInt32LE(end) !== 0x06054b50) end--;
  requireArchive(
    end >= 0 &&
      end + 22 + zip.readUInt16LE(end + 20) === zip.length &&
      zip.readUInt32LE(end + 4) === 0,
  );
  const count = zip.readUInt16LE(end + 10);
  let cursor = zip.readUInt32LE(end + 16);
  requireArchive(
    count > 0 &&
      count <= PACK_LIMITS.files + 1 &&
      count === zip.readUInt16LE(end + 8) &&
      cursor + zip.readUInt32LE(end + 12) === end,
  );
  const directoryStart = cursor;
  const entries = new Map<string, Buffer>();
  const folded = new Set<string>();
  const ranges: [number, number][] = [];
  let total = 0;
  for (let i = 0; i < count; i++) {
    requireArchive(cursor + 46 <= end && zip.readUInt32LE(cursor) === 0x02014b50);
    const flags = zip.readUInt16LE(cursor + 8),
      method = zip.readUInt16LE(cursor + 10);
    const compressed = zip.readUInt32LE(cursor + 20),
      size = zip.readUInt32LE(cursor + 24);
    const nameSize = zip.readUInt16LE(cursor + 28),
      extra = zip.readUInt16LE(cursor + 30),
      comment = zip.readUInt16LE(cursor + 32);
    const attr = zip.readUInt32LE(cursor + 38),
      offset = zip.readUInt32LE(cursor + 42);
    requireArchive(
      !(flags & ~0x808) &&
        [0, 8].includes(method) &&
        zip.readUInt16LE(cursor + 34) === 0 &&
        [0, 0x8000].includes((attr >>> 16) & 0xf000),
    );
    requireArchive(
      cursor + 46 + nameSize + extra + comment <= end && offset + 30 <= directoryStart,
    );
    const rawName = zip.subarray(cursor + 46, cursor + 46 + nameSize),
      name = rawName.toString('utf8');
    requireArchive(
      Buffer.from(name).equals(rawName) && !folded.has(name.toLowerCase()) && !name.endsWith('/'),
    );
    folded.add(name.toLowerCase());
    requireArchive(
      zip.readUInt32LE(offset) === 0x04034b50 &&
        zip.readUInt16LE(offset + 6) === flags &&
        zip.readUInt16LE(offset + 8) === method &&
        zip.readUInt16LE(offset + 26) === nameSize,
    );
    const start = offset + 30 + nameSize + zip.readUInt16LE(offset + 28);
    requireArchive(
      start + compressed <= directoryStart &&
        zip.subarray(offset + 30, offset + 30 + nameSize).equals(rawName),
    );
    total += size;
    if (
      size > (name === 'manifest.json' ? PACK_LIMITS.manifest : PACK_LIMITS.file) ||
      total > PACK_LIMITS.total
    )
      throw new Error('package_budget_exceeded');
    requireArchive(size <= Math.max(1024 * 1024, compressed * 100));
    ranges.push([offset, start + compressed]);
    const packed = zip.subarray(start, start + compressed);
    const bytes =
      method === 8 ? await inflate(packed, { maxOutputLength: Math.max(1, size) }) : packed;
    requireArchive(bytes.length === size && crc32(bytes) === zip.readUInt32LE(cursor + 16));
    entries.set(name, bytes);
    cursor += 46 + nameSize + extra + comment;
  }
  ranges.sort((a, b) => a[0] - b[0]);
  requireArchive(
    cursor === end && ranges.every((range, i) => i === 0 || range[0] >= ranges[i - 1]![1]),
  );
  const manifestBytes = entries.get('manifest.json');
  requireArchive(manifestBytes);
  entries.delete('manifest.json');
  const parsed = parseManifest(manifestBytes);
  verifyFiles(parsed.manifest, entries);
  return { ...parsed, manifestBytes, files: entries };
}

/** Write a deterministic ZIP32 container after checking the supplied manifest and files. */
export function writePackArchive(
  manifestBytes: Buffer,
  files: ReadonlyMap<string, Uint8Array>,
): Buffer {
  const { manifest } = parseManifest(manifestBytes);
  verifyFiles(manifest, files);
  const entries: [string, Uint8Array][] = [
    ['manifest.json', manifestBytes],
    ...manifest.files.map((file): [string, Uint8Array] => [file.path, files.get(file.path)!]),
  ];
  const locals: Buffer[] = [];
  const directory: Buffer[] = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const nameBytes = Buffer.from(name, 'utf8');
    const checksum = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.byteLength, 18);
    local.writeUInt32LE(data.byteLength, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(data.byteLength, 20);
    central.writeUInt32LE(data.byteLength, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, Buffer.from(data));
    directory.push(central, nameBytes);
    offset += local.length + nameBytes.length + data.byteLength;
  }
  const centralBytes = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  if (offset + centralBytes.length + end.length > PACK_LIMITS.total)
    throw new Error('package_budget_exceeded');
  return Buffer.concat([...locals, centralBytes, end]);
}
