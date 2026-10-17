import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { prepareIsolatedPack } from '../src/orchestration/prepare-pack.js';
import { verifyIsolatedPack } from '../src/orchestration/isolated-pack.js';
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'mizar-isolation-'));
  roots.push(root);
  const source = join(root, 'Mtp');
  await mkdir(join(source, 'CamMacros'), { recursive: true });
  await mkdir(join(source, 'Campaths'));
  const original = 'name: Mtp\nOnNewRound:\n  - begin\n';
  await writeFile(join(source, 'Mtp.yaml'), original);
  await writeFile(join(source, 'CamMacros', 'begin.yaml'), 'name: begin\n');
  return { root, source, original };
}
it('copies user resources into a unique pack with no automatic lists and leaves the original intact', async () => {
  const { root, source, original } = await fixture();
  expect(verifyIsolatedPack(root, 'Mtp')).toBe(false);
  const pack = await prepareIsolatedPack(source, root);
  expect(verifyIsolatedPack(root, pack.name)).toBe(true);
  expect(await readFile(join(source, 'Mtp.yaml'), 'utf8')).toBe(original);
  expect(await readFile(join(root, pack.name, 'CamMacros', 'begin.yaml'), 'utf8')).toBe(
    'name: begin\n',
  );
  const path = join(root, pack.name, `${pack.name}.yaml`);
  const metadata = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  expect(metadata).toMatchObject({
    name: pack.name,
    KCP: { usable: false },
    OnNewRound: [],
    OnRoundStart: [],
    OnRoundEnd: [],
  });
  metadata.OnNewRound = ['begin'];
  await writeFile(path, JSON.stringify(metadata));
  expect(verifyIsolatedPack(root, pack.name)).toBe(false);
  expect(verifyIsolatedPack(undefined, pack.name)).toBe(false);
  expect(verifyIsolatedPack(root, '../Mtp')).toBe(false);
});
it('rejects symlinked resources and never seals a failed copy', async () => {
  const { root, source } = await fixture();
  await symlink(join(source, 'Mtp.yaml'), join(source, 'CamMacros', 'link.yaml'));
  await expect(prepareIsolatedPack(source, root)).rejects.toThrow('pack_unsafe_entry');
});
