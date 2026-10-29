import { createHash } from 'node:crypto';
import { crc32, deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { readPackArchive, writePackArchive } from '../src/index.js';

function archive(
  files: [string, Buffer][],
  options: {
    symlink?: boolean;
    deflate?: boolean;
    utf8?: boolean;
    localExtra?: Buffer;
    centralExtra?: Buffer;
  } = {},
) {
  const locals: Buffer[] = [],
    central: Buffer[] = [];
  let offset = 0;
  for (const [name, bytes] of files) {
    const n = Buffer.from(name),
      packed = options.deflate ? deflateRawSync(bytes) : bytes;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(options.utf8 ? 0x800 : 0, 6);
    local.writeUInt16LE(options.deflate ? 8 : 0, 8);
    local.writeUInt32LE(crc32(bytes), 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(bytes.length, 22);
    local.writeUInt16LE(n.length, 26);
    local.writeUInt16LE(options.localExtra?.length ?? 0, 28);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(options.utf8 ? 0x800 : 0, 8);
    header.writeUInt16LE(options.deflate ? 8 : 0, 10);
    header.writeUInt32LE(crc32(bytes), 16);
    header.writeUInt32LE(packed.length, 20);
    header.writeUInt32LE(bytes.length, 24);
    header.writeUInt16LE(n.length, 28);
    header.writeUInt16LE(options.centralExtra?.length ?? 0, 30);
    header.writeUInt32LE(options.symlink ? 0xa0000000 : 0, 38);
    header.writeUInt32LE(offset, 42);
    const localExtra = options.localExtra ?? Buffer.alloc(0);
    const centralExtra = options.centralExtra ?? Buffer.alloc(0);
    locals.push(local, n, localExtra, packed);
    central.push(header, n, centralExtra);
    offset += local.length + n.length + localExtra.length + packed.length;
  }
  const directory = Buffer.concat(central),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
const content = Buffer.from('hello');
const manifest = Buffer.from(
  JSON.stringify({
    format: 'mizar.pack',
    formatVersion: 1,
    packageId: '5a72a7f4-6e27-4f32-8b3a-9d2ab35963dc',
    version: '1.0.0',
    name: 'test',
    author: '',
    modules: [],
    presets: [],
    dependencies: [],
    requirements: [],
    files: [
      {
        id: 'a',
        path: 'assets/a.txt',
        mediaType: 'text/plain',
        bytes: content.length,
        sha256: createHash('sha256').update(content).digest('hex'),
      },
    ],
  }),
);
const members: [string, Buffer][] = [
  ['manifest.json', manifest],
  ['assets/a.txt', content],
];

describe('pack archive', () => {
  it('reads stored and deflated members with identical identities', async () => {
    const stored = await readPackArchive(archive(members));
    const compressed = await readPackArchive(archive(members, { deflate: true }));
    expect(stored.digest).toBe(compressed.digest);
    expect(compressed.files.get('assets/a.txt')).toEqual(content);
  });
  it('writes a verified archive that round trips', async () => {
    const files = new Map([['assets/a.txt', content]]);
    const zip = writePackArchive(manifest, files);
    expect(writePackArchive(manifest, files)).toEqual(zip);
    const result = await readPackArchive(zip);
    expect(result.files.get('assets/a.txt')).toEqual(content);
    expect(() => writePackArchive(manifest, new Map())).toThrow();
  });
  it('rejects conflicting Unicode path metadata and unmarked non-ASCII names', async () => {
    const unicodePath = Buffer.from([0x75, 0x70, 0, 0]);
    await expect(readPackArchive(archive(members, { localExtra: unicodePath }))).rejects.toThrow();
    await expect(
      readPackArchive(archive(members, { centralExtra: unicodePath })),
    ).rejects.toThrow();
    await expect(
      readPackArchive(archive(members, { localExtra: Buffer.from([1, 0, 1, 0]) })),
    ).rejects.toThrow();
    const unicodeManifest = Buffer.from(
      manifest.toString().replace('assets/a.txt', 'assets/中.txt'),
    );
    const unicodeMembers: [string, Buffer][] = [
      ['manifest.json', unicodeManifest],
      ['assets/中.txt', content],
    ];
    await expect(readPackArchive(archive(unicodeMembers))).rejects.toThrow();
    await expect(readPackArchive(archive(unicodeMembers, { utf8: true }))).resolves.toBeDefined();
    await expect(
      readPackArchive(archive(members, { localExtra: Buffer.from([1, 0, 0, 0]) })),
    ).resolves.toBeDefined();
  });
  it('rejects unlisted, duplicate, damaged and symbolic link members', async () => {
    await expect(readPackArchive(archive([...members, ['extra', content]]))).rejects.toThrow();
    await expect(
      readPackArchive(archive([...members, ['assets/A.txt', content]])),
    ).rejects.toThrow();
    await expect(
      readPackArchive(archive([members[0]!, ['assets/a.txt', Buffer.from('wrong')]])),
    ).rejects.toThrow();
    await expect(readPackArchive(archive(members, { symlink: true }))).rejects.toThrow();
  });
});
