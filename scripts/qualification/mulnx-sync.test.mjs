import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { expect, it } from 'vitest';
import { publishSnapshot } from './mulnx-sync.mjs';
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
function fixture() {
  const data = Buffer.from('original');
  const identity = { size: data.length, sha256: hash(data) };
  const release = { id: 1, assetId: 2, ...identity };
  const index = Buffer.from(
    JSON.stringify({
      release,
      notices: { 'LICENSE.txt': identity, 'COPYRIGHT.md': identity, 'SECURITY.md': identity },
    }),
  );
  const dirs = new Set(['/']);
  const files = new Map();
  const writes = [];
  const box = {
    async list(folder) {
      return [...dirs]
        .filter(
          (path) =>
            path !== '/' && path.slice(0, path.lastIndexOf('/')) === (folder === '/' ? '' : folder),
        )
        .map((path) => ({ name: path.split('/').at(-1), type: 'dir' }))
        .concat(
          [...files.keys()]
            .filter((path) => path.slice(0, path.lastIndexOf('/')) === folder)
            .map((path) => ({ name: path.split('/').at(-1), type: 'file' })),
        );
    },
    async api(_endpoint, path) {
      dirs.add(path);
    },
    async upload(folder, name, bytes) {
      writes.push(`${folder}/${name}`);
      files.set(`${folder}/${name}`, bytes);
    },
    async hash(path) {
      const bytes = files.get(path);
      return { size: bytes.length, sha256: hash(bytes) };
    },
  };
  return { data, release, index, writes, box };
}
it('publishes the pointer only after every signed file is read back', async () => {
  const f = fixture();
  await publishSnapshot(
    f.box,
    f.index,
    {},
    async () => f.data,
    async () => f.release,
  );
  expect(f.writes.at(-1)).toBe('/Tools/MulNX/latest.json');
  expect(f.writes).toHaveLength(5);
  expect(f.writes.every((path) => path.startsWith('/Tools/MulNX/'))).toBe(true);
});
it('preserves the pointer for corrupt bytes or a changed upstream release', async () => {
  const f = fixture();
  await expect(
    publishSnapshot(
      f.box,
      f.index,
      {},
      async () => Buffer.from('changed'),
      async () => f.release,
    ),
  ).rejects.toThrow('signed index');
  expect(f.writes).not.toContain('/Tools/MulNX/latest.json');
  await expect(
    publishSnapshot(
      f.box,
      f.index,
      {},
      async () => f.data,
      async () => ({ ...f.release, id: 3 }),
    ),
  ).rejects.toThrow('candidate changed');
  expect(f.writes).not.toContain('/Tools/MulNX/latest.json');
});
it('preserves the pointer when Box readback differs', async () => {
  const f = fixture();
  const originalHash = f.box.hash;
  f.box.hash = async (path) =>
    path.endsWith('MulNX.7z') ? { size: 0, sha256: '0'.repeat(64) } : originalHash(path);
  await expect(
    publishSnapshot(
      f.box,
      f.index,
      {},
      async () => f.data,
      async () => f.release,
    ),
  ).rejects.toThrow('readback mismatch');
  expect(f.writes).not.toContain('/Tools/MulNX/latest.json');
});
