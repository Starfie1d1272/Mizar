import { readFileSync } from 'node:fs';
import { programSnapshotSchema } from '@mizar/protocol/program';
import { crc32, deflateRawSync } from 'node:zlib';
/** Generated PCM silence only; no third-party or private audio. */
export function musicWav(value = 0) {
  const b = Buffer.alloc(2044);
  b.write('RIFF');
  b.writeUInt32LE(b.length - 8, 4);
  b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(8000, 24);
  b.writeUInt32LE(16000, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(2000, 40);
  b.fill(value, 44);
  return b;
}
/** Independent ordinary ZIP32 producer, with Unix permissions, for import boundary tests. */
export function musicZip(files: Record<string, Buffer>, attributes: Record<string, number> = {}) {
  const locals: Buffer[] = [],
    directory: Buffer[] = [];
  let offset = 0;
  for (const [path, bytes] of Object.entries(files)) {
    const name = Buffer.from(path),
      compressed = deflateRawSync(bytes),
      local = Buffer.alloc(30),
      central = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc32(bytes), 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(bytes.length, 22);
    local.writeUInt16LE(name.length, 26);
    central.writeUInt32LE(0x02014b50);
    central.writeUInt16LE(0x314, 4);
    local.copy(central, 6, 4, 30);
    central.writeUInt32LE(attributes[path] ?? 0x81a40000, 38);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, compressed);
    directory.push(central, name);
    offset += 30 + name.length + compressed.length;
  }
  const cd = Buffer.concat(directory),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(directory.length / 2, 8);
  end.writeUInt16LE(directory.length / 2, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}
export function musicManifest() {
  return {
    format: 'mizar.local-music',
    version: 1,
    groups: {
      waiting: { tracks: [{ path: 'audio/等待.wav' }] },
      tactical: { tracks: [] },
      technical: { tracks: [] },
      halftime: { tracks: [] },
      mapVictory: { tracks: [] },
      matchVictory: { tracks: [] },
      opening: { tracks: [] },
    },
  };
}

export function musicProgram() {
  const artifact = JSON.parse(
    readFileSync(
      new URL(
        '../../web/src/program/fixtures/generated/real-program-fixtures.generated.json',
        import.meta.url,
      ),
      'utf8',
    ),
  ) as { fixtures: Record<string, { snapshot: unknown }> };
  const snapshot = programSnapshotSchema.parse(artifact.fixtures['real-live-rich']!.snapshot);
  return { ...snapshot.payload, cursor: snapshot.cursor };
}
