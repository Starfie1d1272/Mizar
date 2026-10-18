import { crc32, inflateRaw } from 'node:zlib';
import { promisify } from 'node:util';
const inflate = promisify(inflateRaw);
import { z } from 'zod';
import { musicGroupSchema, MUSIC_GROUPS } from '@mizar/protocol/music';

export const MUSIC_MAX_BYTES = 128 * 1024 * 1024;
export const AUDIO_EXTENSION = /\.(wav|mp3|ogg|flac|m4a)$/i;
export function audioBytes(name: string, bytes: Buffer): boolean {
  const ext = name.split('.').at(-1)?.toLowerCase();
  if (!bytes.length || bytes.length > 32 * 1024 * 1024) return false;
  if (ext === 'wav')
    return bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WAVE';
  if (ext === 'flac') return bytes.toString('ascii', 0, 4) === 'fLaC';
  if (ext === 'ogg') return bytes.toString('ascii', 0, 4) === 'OggS';
  if (ext === 'm4a') return bytes.toString('ascii', 4, 8) === 'ftyp';
  return (
    ext === 'mp3' &&
    (bytes.toString('ascii', 0, 3) === 'ID3' || (bytes[0] === 255 && (bytes[1]! & 224) === 224))
  );
}
function requireZip(ok: unknown): asserts ok {
  if (!ok) throw new Error('music_archive_invalid');
}
function relativePath(path: string): boolean {
  return (
    path.length <= 240 &&
    !/[\\:]/.test(path) &&
    [...path].every((c) => c.charCodeAt(0) >= 32) &&
    path
      .split('/')
      .every(
        (p) =>
          p &&
          p !== '.' &&
          p !== '..' &&
          !/[. ]$/.test(p) &&
          !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p),
      )
  );
}
const packGroup = musicGroupSchema.omit({ tracks: true }).extend({
  tracks: z
    .array(
      z
        .object({
          path: z.string().max(240),
          startMs: z.number().int().min(0).max(86_400_000).default(0),
          endMs: z.number().int().min(1).max(86_400_000).nullable().default(null),
        })
        .strict(),
    )
    .max(64),
});
const manifestSchema = z
  .object({
    format: z.literal('mizar.local-music'),
    version: z.literal(1),
    groups: z
      .object(
        Object.fromEntries(MUSIC_GROUPS.map((g) => [g, packGroup])) as Record<
          (typeof MUSIC_GROUPS)[number],
          typeof packGroup
        >,
      )
      .strict(),
  })
  .strict();

/** Bounded ZIP32 reader. No filesystem extraction. Official resource authorization is separate. */
export async function readMusicPack(zip: Buffer) {
  requireZip(zip.length >= 22 && zip.length <= MUSIC_MAX_BYTES);
  let end = zip.length - 22;
  while (end >= Math.max(0, zip.length - 65557) && zip.readUInt32LE(end) !== 0x06054b50) end--;
  requireZip(end >= 0 && zip.readUInt32LE(end) === 0x06054b50);
  requireZip(
    end + 22 + zip.readUInt16LE(end + 20) === zip.length && zip.readUInt32LE(end + 4) === 0,
  );
  const count = zip.readUInt16LE(end + 10);
  let cursor = zip.readUInt32LE(end + 16),
    total = 0;
  requireZip(
    count > 0 &&
      count <= 129 &&
      count === zip.readUInt16LE(end + 8) &&
      cursor + zip.readUInt32LE(end + 12) === end,
  );
  const directoryStart = cursor,
    entries = new Map<string, Buffer>(),
    folded = new Set<string>();
  const ranges: [number, number][] = [];
  for (let i = 0; i < count; i++) {
    requireZip(cursor + 46 <= end && zip.readUInt32LE(cursor) === 0x02014b50);
    const flags = zip.readUInt16LE(cursor + 8),
      method = zip.readUInt16LE(cursor + 10);
    const compressed = zip.readUInt32LE(cursor + 20),
      size = zip.readUInt32LE(cursor + 24);
    const nameSize = zip.readUInt16LE(cursor + 28),
      extra = zip.readUInt16LE(cursor + 30),
      comment = zip.readUInt16LE(cursor + 32);
    const attr = zip.readUInt32LE(cursor + 38),
      offset = zip.readUInt32LE(cursor + 42);
    requireZip(
      !(flags & ~0x808) &&
        [0, 8].includes(method) &&
        zip.readUInt16LE(cursor + 34) === 0 &&
        ((attr >>> 16) & 0xf000) !== 0xa000 &&
        [0, 0x4000, 0x8000].includes((attr >>> 16) & 0xf000),
    );
    requireZip(cursor + 46 + nameSize + extra + comment <= end && offset + 30 <= directoryStart);
    const rawName = zip.subarray(cursor + 46, cursor + 46 + nameSize),
      name = rawName.toString('utf8');
    const isDirectory = name.endsWith('/');
    requireZip(
      relativePath(isDirectory ? name.slice(0, -1) : name) &&
        Buffer.from(name).equals(rawName) &&
        !folded.has(name.toLowerCase()) &&
        (isDirectory || name === 'music.json' || AUDIO_EXTENSION.test(name)),
    );
    folded.add(name.toLowerCase());
    requireZip(
      zip.readUInt32LE(offset) === 0x04034b50 &&
        zip.readUInt16LE(offset + 6) === flags &&
        zip.readUInt16LE(offset + 8) === method &&
        zip.readUInt16LE(offset + 26) === nameSize,
    );
    const start = offset + 30 + nameSize + zip.readUInt16LE(offset + 28);
    requireZip(
      start + compressed <= directoryStart &&
        zip.subarray(offset + 30, offset + 30 + nameSize).equals(rawName),
    );
    total += size;
    requireZip(
      (isDirectory ? size === 0 : size > 0) &&
        size <= (name === 'music.json' ? 128 * 1024 : 32 * 1024 * 1024) &&
        total <= MUSIC_MAX_BYTES &&
        size <= Math.max(1024 * 1024, compressed * 100),
    );
    ranges.push([offset, start + compressed]);
    const packed = zip.subarray(start, start + compressed);
    const bytes =
      method === 8 ? await inflate(packed, { maxOutputLength: Math.max(1, size) }) : packed;
    requireZip(bytes.length === size && crc32(bytes) === zip.readUInt32LE(cursor + 16));
    if (!isDirectory) {
      if (name !== 'music.json') requireZip(audioBytes(name, bytes));
      entries.set(name, bytes);
    }
    cursor += 46 + nameSize + extra + comment;
  }
  ranges.sort((a, b) => a[0] - b[0]);
  requireZip(cursor === end && ranges.every((r, i) => i === 0 || r[0] >= ranges[i - 1]![1]));
  const manifest = manifestSchema.parse(
    JSON.parse(entries.get('music.json')?.toString('utf8') ?? 'null'),
  );
  const referenced = new Set<string>();
  for (const group of MUSIC_GROUPS)
    for (const track of manifest.groups[group].tracks) {
      requireZip(
        relativePath(track.path) &&
          track.path !== 'music.json' &&
          entries.has(track.path) &&
          (track.endMs === null || track.endMs > track.startMs),
      );
      referenced.add(track.path);
    }
  requireZip(entries.size === referenced.size + 1);
  return { manifest, entries };
}
