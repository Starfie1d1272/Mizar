import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import pin from '../../apps/companion/src/telemetry/observer-component.json' with { type: 'json' };
const execute = promisify(execFile);
async function inspectNode(node) {
  const { stdout } = await execute(
    node,
    [
      '-e',
      'console.log(JSON.stringify({version:process.versions.node,platform:process.platform,arch:process.arch}))',
    ],
    { windowsHide: true, timeout: 10000, maxBuffer: 4096 },
  );
  return JSON.parse(stdout);
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const digest = /^[a-f0-9]{64}$/;
const entrypoints = {
  python: 'runtime/python/python.exe',
  driver: 'client/driver.py',
  native: 'client/cs2_observer.dll',
  worker: 'client/parser_worker.mjs',
};

export async function stageReleasedObserver(resourcesDirectory, temporaryDirectory) {
  const archive = join(temporaryDirectory, pin.asset);
  const response = await globalThis.fetch(
    `https://github.com/Starfie1d1272/cs2-headless-observer/releases/download/v${pin.version}/${pin.asset}`,
    { signal: globalThis.AbortSignal.timeout(180000) },
  );
  if (!response.ok) throw new Error(`observer_download_http_${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (sha256(bytes) !== pin.sha256) throw new Error('observer_release_hash');
  await writeFile(archive, bytes, { flag: 'wx' });
  const extracted = join(temporaryDirectory, 'observer-extracted');
  await mkdir(extracted);
  await execute('tar', ['-xf', archive, '-C', extracted], { windowsHide: true });
  const manifest = JSON.parse(await readFile(join(extracted, 'manifest.json'), 'utf8'));
  if (manifest.componentVersion !== pin.version || manifest.sourceSha !== pin.sourceSha)
    throw new Error('observer_release_identity');
  return stageObserverComponent(extracted, resourcesDirectory);
}

function safePath(name) {
  return (
    typeof name === 'string' &&
    !name.includes('\\') &&
    !name.includes(':') &&
    name.split('/').every((part) => part && part !== '.' && part !== '..') &&
    !name.startsWith('/')
  );
}

async function files(directory, prefix = '') {
  const found = [];
  for (const name of await readdir(directory)) {
    const path = join(directory, name);
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) throw new Error('observer_component_symlink');
    if (stat.isDirectory()) found.push(...(await files(path, prefix + name + '/')));
    else if (stat.isFile()) found.push(prefix + name);
    else throw new Error('observer_component_file_type');
  }
  return found.sort();
}

/** Build-time staging and Node capability probe. No Steam, network or component activation. */
export async function stageObserverComponent(
  componentDirectory,
  resourcesDirectory,
  { allowDirty = false, inspectRuntime = inspectNode } = {},
) {
  const source = resolve(componentDirectory);
  const resources = resolve(resourcesDirectory);
  if (
    source === resources ||
    source.startsWith(resources + sep) ||
    resources.startsWith(source + sep)
  )
    throw new Error('observer_component_overlapping_paths');
  const manifestBytes = await readFile(join(source, 'manifest.json'));
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  if (
    manifest.schema !== 'cs2-headless-observer-package/4' ||
    manifest.distribution !== 'external-node' ||
    manifest.componentId !== 'cs2-headless-observer' ||
    !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(manifest.componentVersion) ||
    !/^[a-f0-9]{40}$/.test(manifest.sourceSha) ||
    typeof manifest.workingTreeDirty !== 'boolean' ||
    manifest.platform !== 'win32-x64' ||
    manifest.nativeAbi !== 3 ||
    manifest.parserIpc !== 3 ||
    manifest.managedProtocol !== 'cs2-observer-managed-json/1' ||
    !Array.isArray(manifest.validatedHostVersions) ||
    !manifest.validatedHostVersions.length ||
    manifest.validatedHostVersions.some(
      (host) => !Number.isInteger(host) || host <= 0 || host > 0xffffffff,
    ) ||
    new Set(manifest.validatedHostVersions).size !== manifest.validatedHostVersions.length ||
    manifest.nodeRequirement?.minimumMajor !== 24 ||
    !manifest.filesSha256 ||
    typeof manifest.filesSha256 !== 'object' ||
    Array.isArray(manifest.filesSha256) ||
    Object.entries(entrypoints).some(([key, value]) => manifest.entrypoints?.[key] !== value)
  )
    throw new Error('observer_component_contract');
  if (manifest.workingTreeDirty && !allowDirty) throw new Error('observer_component_dirty_source');
  const expected = Object.keys(manifest.filesSha256).sort();
  if (
    expected.some((name) => !safePath(name) || !digest.test(manifest.filesSha256[name])) ||
    expected.some((name) => /(^|\/)steam_api64\.dll$/i.test(name)) ||
    expected.includes('runtime/node.exe') ||
    expected.includes('manifest.json') ||
    Object.values(entrypoints).some((name) => !expected.includes(name))
  )
    throw new Error('observer_component_inventory');
  const actual = await files(source);
  if (JSON.stringify(actual) !== JSON.stringify([...expected, 'manifest.json'].sort()))
    throw new Error('observer_component_inventory');
  for (const name of expected) {
    if (sha256(await readFile(join(source, name))) !== manifest.filesSha256[name])
      throw new Error('observer_component_file_hash');
  }
  const node = join(resources, 'runtime/node.exe');
  const runtime = await inspectRuntime(node);
  if (
    !/^\d+\.\d+\.\d+$/.test(runtime.version) ||
    Number(runtime.version.split('.')[0]) < manifest.nodeRequirement.minimumMajor ||
    runtime.platform !== 'win32' ||
    runtime.arch !== 'x64'
  )
    throw new Error('observer_component_node_requirement');
  const destination = join(resources, 'observer');
  try {
    await lstat(destination);
    throw new Error('observer_component_destination_exists');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const temporary = await mkdtemp(join(resources, '.observer-stage-'));
  if (
    dirname(temporary) !== resources ||
    !temporary.startsWith(join(resources, '.observer-stage-'))
  )
    throw new Error('observer_component_cleanup_boundary');
  try {
    const staged = join(temporary, 'observer');
    await mkdir(staged);
    for (const name of expected) {
      const bytes = await readFile(join(source, name));
      if (sha256(bytes) !== manifest.filesSha256[name])
        throw new Error('observer_component_file_changed');
      await mkdir(dirname(join(staged, name)), { recursive: true });
      await writeFile(join(staged, name), bytes, { flag: 'wx' });
    }
    await writeFile(join(staged, 'manifest.json'), manifestBytes, { flag: 'wx' });
    await rename(staged, destination);
  } finally {
    // The unique temporary directory is created under this build's resources root.
    await rm(temporary, { recursive: true, force: true });
  }
  const receipt = {
    schemaVersion: 1,
    componentId: manifest.componentId,
    componentVersion: manifest.componentVersion,
    sourceSha: manifest.sourceSha,
    workingTreeDirty: manifest.workingTreeDirty,
    manifestSha256: sha256(manifestBytes),
    nodeRuntime: { ...runtime, executableSha256: sha256(await readFile(node)) },
    launch: {
      ...Object.fromEntries(
        Object.entries(entrypoints).map(([key, value]) => [key, 'resources/observer/' + value]),
      ),
      node: 'resources/runtime/node.exe',
    },
  };
  await mkdir(join(resources, 'metadata'), { recursive: true });
  await writeFile(
    join(resources, 'metadata/observer-component.json'),
    JSON.stringify(receipt, null, 2) + '\n',
    { flag: 'wx' },
  );
  return receipt;
}
