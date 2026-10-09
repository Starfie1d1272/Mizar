import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rename, unlink } from 'node:fs/promises';
import { dirname, join, parse, relative as relativePath, resolve, sep } from 'node:path';
import { ResourceStoreError, type TrustedPack } from './contract.js';

export const limits = {
  files: 4096,
  totalBytes: 512 * 1024 * 1024,
  fileBytes: 128 * 1024 * 1024,
  receiptBytes: 2 * 1024 * 1024,
};
const types: Record<string, string> = {
  json: 'application/json',
  jsonl: 'application/x-ndjson',
  mp4: 'video/mp4',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  txt: 'text/plain; charset=utf-8',
  md: 'text/plain; charset=utf-8',
};

export function contentType(path: string): string {
  const type = types[path.split('.').at(-1)?.toLowerCase() ?? ''];
  if (!type) throw new ResourceStoreError('resource_type_forbidden');
  return type;
}

export function checkPath(path: string): void {
  if (
    typeof path !== 'string' ||
    path.length > 512 ||
    !path.length ||
    path.includes('\\') ||
    path.includes(':')
  )
    throw new ResourceStoreError('resource_path_invalid');
  for (const part of path.split('/')) {
    if (
      !/^[a-zA-Z0-9_][a-zA-Z0-9_. -]*$/.test(part) ||
      /[. ]$/.test(part) ||
      /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part)
    )
      throw new ResourceStoreError('resource_path_invalid');
  }
}

export function checkDescriptor(pack: TrustedPack, packId: string): TrustedPack {
  if (
    !pack ||
    pack.packId !== packId ||
    typeof pack.packVersion !== 'string' ||
    !pack.packVersion.length ||
    pack.packVersion.length > 128 ||
    typeof pack.compatible !== 'boolean' ||
    !Array.isArray(pack.files) ||
    !pack.files.length ||
    pack.files.length > limits.files
  )
    throw new ResourceStoreError('resource_descriptor_invalid');
  let total = 0;
  const names = new Set<string>();
  const files = pack.files.map((file: TrustedPack['files'][number]) => {
    checkPath(file.path);
    contentType(file.path);
    const key = file.path.toLowerCase();
    if (
      typeof file.sha256 !== 'string' ||
      names.has(key) ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes < 0 ||
      file.bytes > limits.fileBytes ||
      !/^[a-f0-9]{64}$/.test(file.sha256)
    )
      throw new ResourceStoreError('resource_descriptor_invalid');
    names.add(key);
    total += file.bytes;
    return { path: file.path, bytes: file.bytes, sha256: file.sha256 };
  });
  if (total > limits.totalBytes) throw new ResourceStoreError('resource_size_exceeded');
  return { packId, packVersion: pack.packVersion, compatible: pack.compatible, files };
}

/** Recheck every ancestor, including the root. A verified fd, rather than a path, owns each read. */
export async function safePath(root: string, relative = ''): Promise<string> {
  const absoluteRoot = resolve(root);
  const parsedRoot = parse(absoluteRoot).root;
  const rootParts = relativePath(parsedRoot, absoluteRoot).split(sep).filter(Boolean);
  let current = parsedRoot;
  for (const component of rootParts) {
    current = join(current, component);
    const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new ResourceStoreError('resource_path_unsafe');
  }
  if (relative) {
    checkPath(relative);
    const parts = relative.split('/');
    for (const component of parts.slice(0, -1)) {
      current = join(current, component);
      const stat = await lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new ResourceStoreError('resource_path_unsafe');
    }
    current = join(current, parts.at(-1)!);
    const stat = await lstat(current);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
      throw new ResourceStoreError('resource_path_unsafe');
  }
  const canonical = await realpath(current);
  if (canonical !== absoluteRoot && !canonical.startsWith(absoluteRoot + sep))
    throw new ResourceStoreError('resource_path_unsafe');
  return current;
}

export async function checkTree(root: string): Promise<void> {
  await safePath(root);
  let count = 0,
    bytes = 0;
  const walk = async (directory: string, depth: number): Promise<void> => {
    if (depth > 16) throw new ResourceStoreError('resource_size_exceeded');
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (++count > limits.files * 2) throw new ResourceStoreError('resource_size_exceeded');
      const path = join(directory, entry.name);
      const stat = await lstat(path);
      if (
        stat.isSymbolicLink() ||
        (!stat.isDirectory() && !stat.isFile()) ||
        (stat.isFile() && stat.nlink !== 1)
      )
        throw new ResourceStoreError('resource_path_unsafe');
      if (stat.isDirectory()) await walk(path, depth + 1);
      else {
        bytes += stat.size;
        if (stat.size > limits.fileBytes || bytes > limits.totalBytes + limits.receiptBytes)
          throw new ResourceStoreError('resource_size_exceeded');
      }
    }
  };
  await walk(root, 0);
}

export async function verifiedRead(
  root: string,
  file: TrustedPack['files'][number],
  signal: AbortSignal,
  consume: (chunk: Buffer, offset: number) => void | Promise<void>,
): Promise<string> {
  signal.throwIfAborted();
  const path = await safePath(root, file.path);
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat();
    const named = await lstat(await safePath(root, file.path));
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.size !== file.bytes ||
      before.ino !== named.ino ||
      before.dev !== named.dev
    )
      throw new ResourceStoreError('resource_file_changed');
    const digest = createHash('sha256');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let offset = 0;
    while (true) {
      signal.throwIfAborted();
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      if (!bytesRead) break;
      offset += bytesRead;
      if (offset > file.bytes) throw new ResourceStoreError('resource_size_mismatch');
      const chunk = buffer.subarray(0, bytesRead);
      digest.update(chunk);
      await consume(chunk, offset - bytesRead);
    }
    const after = await handle.stat();
    if (
      offset !== file.bytes ||
      digest.digest('hex') !== file.sha256 ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      throw new ResourceStoreError('resource_integrity_failed');
    const finalNamed = await lstat(await safePath(root, file.path));
    if (
      finalNamed.ino !== after.ino ||
      finalNamed.dev !== after.dev ||
      finalNamed.size !== after.size ||
      finalNamed.mtimeMs !== after.mtimeMs
    )
      throw new ResourceStoreError('resource_file_changed');
    return path;
  } finally {
    await handle.close();
  }
}

export async function readJson(root: string, relative: string): Promise<unknown> {
  const path = await safePath(root, relative);
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limits.receiptBytes || stat.nlink !== 1)
      throw new ResourceStoreError('resource_receipt_invalid');
    // Bounded even if another local process extends the file after stat.
    const buffer = Buffer.alloc(limits.receiptBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > limits.receiptBytes) throw new ResourceStoreError('resource_receipt_invalid');
    return JSON.parse(buffer.subarray(0, bytesRead).toString('utf8')) as unknown;
  } finally {
    await handle.close();
  }
}

export async function atomicJson(path: string, value: unknown): Promise<void> {
  const body = JSON.stringify(value);
  if (!body || Buffer.byteLength(body) > limits.receiptBytes)
    throw new ResourceStoreError('resource_receipt_invalid');
  await safePath(dirname(path));
  const temporary = join(dirname(path), `tmp-${randomUUID()}.json`);
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(body);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
    await syncDirectory(dirname(path));
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

export async function syncDirectory(path: string): Promise<void> {
  // Windows does not expose directory fsync through Node. File fsync + rename remain required.
  if (process.platform === 'win32') return;
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function ensureDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await safePath(path);
}
