import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, it } from 'vitest';
import { stageObserverComponent } from './observer-component.mjs';
const inspectRuntime = async () => ({ version: '24.21.0', platform: 'win32', arch: 'x64' });
const stage = (source, resources, options = {}) =>
  stageObserverComponent(source, resources, { inspectRuntime, ...options });

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'mizar-observer-stage-'));
  if (!root.startsWith(join(tmpdir(), 'mizar-observer-stage-')))
    throw new Error('test_cleanup_boundary');
  try {
    const source = join(root, 'component'),
      resources = join(root, 'product/resources');
    const data = {
      'runtime/python/python.exe': 'synthetic-python-not-executable',
      'client/driver.py': 'synthetic-driver',
      'client/cs2_observer.dll': 'synthetic-native-not-executable',
      'client/parser_worker.mjs': 'synthetic-worker',
      'source/LICENSE': 'synthetic-source-notice',
    };
    for (const [name, value] of Object.entries(data)) {
      await mkdir(dirname(join(source, name)), { recursive: true });
      await writeFile(join(source, name), value);
    }
    await mkdir(join(resources, 'runtime'), { recursive: true });
    await writeFile(join(resources, 'runtime/node.exe'), 'synthetic-shared-node');
    const manifest = {
      schema: 'cs2-headless-observer-package/4',
      distribution: 'external-node',
      componentId: 'cs2-headless-observer',
      componentVersion: '0.0.0',
      sourceSha: 'a'.repeat(40),
      workingTreeDirty: false,
      platform: 'win32-x64',
      nativeAbi: 3,
      parserIpc: 3,
      managedProtocol: 'cs2-observer-managed-json/1',
      validatedHostVersions: [14191, 14192],
      nodeRequirement: { minimumMajor: 24 },
      entrypoints: {
        python: 'runtime/python/python.exe',
        driver: 'client/driver.py',
        native: 'client/cs2_observer.dll',
        worker: 'client/parser_worker.mjs',
      },
      filesSha256: Object.fromEntries(
        Object.entries(data).map(([name, value]) => [name, hash(value)]),
      ),
    };
    const save = () => writeFile(join(source, 'manifest.json'), JSON.stringify(manifest));
    await save();
    await run({ source, resources, manifest, save, data });
  } finally {
    // root is the newly created test-only directory returned by mkdtemp.
    await rm(root, { recursive: true, force: true });
  }
}

it('stages a byte-identical component, reuses product Node and writes launch paths', async () => {
  await fixture(async ({ source, resources, data }) => {
    const receipt = await stage(source, resources);
    expect(receipt.launch.node).toBe('resources/runtime/node.exe');
    expect(receipt.launch.driver).toBe('resources/observer/client/driver.py');
    for (const [name, bytes] of Object.entries(data))
      expect(await readFile(join(resources, 'observer', name), 'utf8')).toBe(bytes);
    expect(
      JSON.parse(await readFile(join(resources, 'metadata/observer-component.json'), 'utf8')),
    ).toEqual(receipt);
    await expect(access(join(resources, 'observer/runtime/node.exe'))).rejects.toThrow();
    await expect(stage(source, resources)).rejects.toThrow('destination_exists');
  });
});

it('rejects changed files, undeclared payload, path escapes and duplicate runtimes', async () => {
  for (const corruption of ['hash', 'extra', 'escape', 'node']) {
    await fixture(async ({ source, resources, manifest, save }) => {
      if (corruption === 'hash') await writeFile(join(source, 'client/driver.py'), 'changed');
      if (corruption === 'extra') await writeFile(join(source, 'unexpected.txt'), 'extra');
      if (corruption === 'escape') {
        manifest.filesSha256['../outside'] = hash('x');
        await save();
      }
      if (corruption === 'node') {
        manifest.filesSha256['runtime/node.exe'] = hash('x');
        await save();
      }
      await expect(stage(source, resources)).rejects.toThrow('observer_component_');
      await expect(access(join(resources, 'observer'))).rejects.toThrow();
    });
  }
});

it('rejects incompatible product runtime and dirty source unless explicitly allowed', async () => {
  await fixture(async ({ source, resources, manifest, save }) => {
    await writeFile(join(resources, 'runtime/node.exe'), 'different-node');
    await expect(
      stage(source, resources, {
        inspectRuntime: async () => ({ version: '22.0.0', platform: 'win32', arch: 'x64' }),
      }),
    ).rejects.toThrow('node_requirement');
    await writeFile(join(resources, 'runtime/node.exe'), 'synthetic-shared-node');
    manifest.workingTreeDirty = true;
    await save();
    await expect(stage(source, resources)).rejects.toThrow('dirty_source');
    await expect(stage(source, resources, { allowDirty: true })).resolves.toMatchObject({
      workingTreeDirty: true,
    });
  });
});
