import test from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stageObserverComponent } from './observer-component.mjs';
import pin from '../../apps/companion/src/telemetry/observer-component.json' with { type: 'json' };

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

test('stageObserverComponent stages package/6 and writes slim receipt', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'mizar-stage-observer-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const source = join(dir, 'source');
  const resources = join(dir, 'resources');
  await mkdir(source);
  await mkdir(resources);
  const exeBytes = Buffer.from('rust-observer-exe');
  const dllBytes = Buffer.from('rust-observer-dll');
  await writeFile(join(source, 'cs2-headless-observer.exe'), exeBytes);
  await writeFile(join(source, 'cs2_observer.dll'), dllBytes);
  await writeFile(
    join(source, 'manifest.json'),
    JSON.stringify({
      schema: 'cs2-headless-observer-package/6',
      componentId: 'cs2-headless-observer',
      componentVersion: pin.version,
      sourceSha: pin.sourceSha,
      platform: 'win32-x64',
      nativeAbi: pin.nativeAbi,
      managedProtocol: pin.managedProtocol,
      validatedHostVersions: [14191, 14192],
      entrypoints: {
        executable: 'cs2-headless-observer.exe',
        native: 'cs2_observer.dll',
      },
      filesSha256: {
        'cs2-headless-observer.exe': sha256(exeBytes),
        'cs2_observer.dll': sha256(dllBytes),
      },
    }),
  );

  const receipt = await stageObserverComponent(source, resources);
  assert.equal(receipt.componentVersion, pin.version);
  assert.equal(receipt.sourceSha, pin.sourceSha);
  assert.equal(receipt.nativeAbi, pin.nativeAbi);
  assert.equal(receipt.managedProtocol, pin.managedProtocol);
  assert.deepEqual(receipt.launch, {
    executable: 'resources/observer/cs2-headless-observer.exe',
    native: 'resources/observer/cs2_observer.dll',
  });
  assert.equal('parserIpc' in receipt, false);
  assert.equal('workingTreeDirty' in receipt, false);
  assert.equal('nodeRuntime' in receipt, false);

  const written = JSON.parse(
    await readFile(join(resources, 'metadata/observer-component.json'), 'utf8'),
  );
  assert.deepEqual(written, receipt);
});

test('stageObserverComponent rejects legacy package/5 manifest', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'mizar-stage-observer-v5-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const source = join(dir, 'source');
  const resources = join(dir, 'resources');
  await mkdir(source);
  await mkdir(resources);
  await writeFile(
    join(source, 'manifest.json'),
    JSON.stringify({
      schema: 'cs2-headless-observer-package/5',
      componentId: 'cs2-headless-observer',
      componentVersion: '4.0.0',
      sourceSha: 'a'.repeat(40),
      platform: 'win32-x64',
      nativeAbi: 4,
      managedProtocol: 'cs2-observer-managed-json/2',
      validatedHostVersions: [14191],
      entrypoints: {
        executable: 'cs2-headless-observer.exe',
        native: 'cs2_observer.dll',
      },
      filesSha256: {},
    }),
  );
  await assert.rejects(stageObserverComponent(source, resources), /observer_component_contract/);
});
