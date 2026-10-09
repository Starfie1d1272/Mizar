import { Buffer } from 'node:buffer';
import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib';
import { LIMITS, assertResourcePath, requireValue } from './index.mjs';

// 确定性 ZIP32：固定时间、普通文件、无 extra/comment/data descriptor；拒绝其它 ZIP 变体。
export function encodeArchive(entries) {
  requireValue(entries.size > 0 && entries.size <= LIMITS.files + 1, 'ZIP 文件数量超限');
  const locals = [],
    central = [];
  let offset = 0;
  for (const [path, bytes] of [...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    assertResourcePath(path);
    const name = Buffer.from(path);
    const method = /\.(json|jsonl|txt)$/.test(path) ? 8 : 0;
    const data = method === 8 ? deflateRawSync(bytes, { level: 9 }) : bytes;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(33, 12);
    local.writeUInt32LE(crc32(bytes), 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(bytes.length, 22);
    local.writeUInt16LE(name.length, 26);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50);
    record.writeUInt16LE(20, 4);
    local.copy(record, 6, 4, 30);
    record.writeUInt32LE(0x20, 38);
    record.writeUInt32LE(offset, 42);
    locals.push(local, name, data);
    central.push(record, name);
    offset += local.length + name.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.size, 8);
  end.writeUInt16LE(entries.size, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  const archive = Buffer.concat([...locals, directory, end]);
  requireValue(archive.length <= LIMITS.archiveBytes, '归档大小超限');
  return archive;
}
export function decodeArchive(archive) {
  requireValue(
    Buffer.isBuffer(archive) && archive.length >= 22 && archive.length <= LIMITS.archiveBytes,
    '归档大小无效',
  );
  const end = archive.subarray(-22);
  requireValue(
    end.readUInt32LE(0) === 0x06054b50 &&
      end.readUInt32LE(4) === 0 &&
      end.readUInt16LE(20) === 0 &&
      end.readUInt16LE(8) === end.readUInt16LE(10),
    'ZIP 尾部、多卷或注释不受支持',
  );
  const count = end.readUInt16LE(8),
    start = end.readUInt32LE(16);
  requireValue(
    count > 0 && count <= LIMITS.files + 1 && start + end.readUInt32LE(12) === archive.length - 22,
    'ZIP 目录无效',
  );
  const entries = new Map(),
    folded = new Set();
  let cursor = start,
    offset = 0,
    total = 0;
  for (let i = 0; i < count; i++) {
    requireValue(cursor + 46 <= archive.length - 22, 'ZIP 目录截断');
    const record = archive.subarray(cursor, cursor + 46),
      nameSize = record.readUInt16LE(28);
    requireValue(
      record.readUInt32LE(0) === 0x02014b50 &&
        record.readUInt16LE(4) === 20 &&
        record.readUInt16LE(6) === 20 &&
        record.readUInt16LE(8) === 0x800 &&
        [0, 8].includes(record.readUInt16LE(10)) &&
        record.readUInt16LE(12) === 0 &&
        record.readUInt16LE(14) === 33 &&
        record.readUInt16LE(30) === 0 &&
        record.readUInt16LE(32) === 0 &&
        record.readUInt16LE(34) === 0 &&
        record.readUInt16LE(36) === 0 &&
        record.readUInt32LE(38) === 0x20 &&
        record.readUInt32LE(42) === offset,
      'ZIP 类型、符号链接或布局无效',
    );
    requireValue(
      cursor + 46 + nameSize <= archive.length - 22 && offset + 30 + nameSize <= start,
      'ZIP 文件名截断',
    );
    const name = archive.subarray(cursor + 46, cursor + 46 + nameSize),
      path = name.toString('utf8');
    assertResourcePath(path);
    requireValue(
      Buffer.from(path).equals(name) && !folded.has(path.toLowerCase()),
      'ZIP 名称重复或编码无效',
    );
    folded.add(path.toLowerCase());
    const local = archive.subarray(offset, offset + 30);
    requireValue(
      local.readUInt32LE(0) === 0x04034b50 &&
        local.subarray(4).equals(record.subarray(6, 32)) &&
        archive.subarray(offset + 30, offset + 30 + nameSize).equals(name),
      'ZIP 本地头与目录不一致',
    );
    const bytes = record.readUInt32LE(24),
      compressed = record.readUInt32LE(20),
      dataStart = offset + 30 + nameSize;
    total += bytes;
    requireValue(
      bytes <= (path === 'pack-manifest.json' ? LIMITS.manifestBytes : LIMITS.fileBytes) &&
        total <= LIMITS.totalBytes + LIMITS.manifestBytes &&
        dataStart + compressed <= start,
      'ZIP 解压字节超限或截断',
    );
    const data = archive.subarray(dataStart, dataStart + compressed);
    const output =
      record.readUInt16LE(10) === 8
        ? inflateRawSync(data, { maxOutputLength: Math.max(1, bytes) })
        : data;
    requireValue(
      output.length === bytes && crc32(output) === record.readUInt32LE(16),
      'ZIP 大小或 CRC 不一致',
    );
    entries.set(path, output);
    offset = dataStart + compressed;
    cursor += 46 + nameSize;
  }
  requireValue(offset === start && cursor === archive.length - 22, 'ZIP 存在额外数据');
  return entries;
}
