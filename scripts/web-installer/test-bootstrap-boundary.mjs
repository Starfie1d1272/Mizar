import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildApp } from '../../apps/companion/dist/app.js';

// A real published Core and its StableSource-authenticated plan are required.
// No Core bytes, App, Store, or publisher verifier are mocked.
const [modulePath, corePath, planPath] = process.argv.slice(2);
if (!modulePath || !corePath || !planPath)
  throw new Error('Supply deployed bootstrap, isolated Core, authenticated plan');
const { completeBootstrap } = await import(pathToFileURL(resolve(modulePath)).href);
const coreRoot = resolve(corePath);
const corePlan = JSON.parse(await readFile(resolve(planPath), 'utf8'));
const root = await mkdtemp(join(await realpath(tmpdir()), 'mizar-bootstrap-boundary-'));
const policy = {
  packVersion: '1.0.0',
  sourceSha: '1'.repeat(40),
  promotionSha: '2'.repeat(40),
  coreVersion: corePlan.version,
  minimumSequence: 0,
  now: Date.now(),
};
const app = buildApp({ resources: { root: join(root, 'assets'), policy } });
const marker = join(coreRoot, 'installed.flag');
// A temp-directory installed marker tests the completion boundary, not NSIS execution.
const existingMarker = await access(marker).then(
  () => true,
  () => false,
);
if (!existingMarker) await writeFile(marker, 'isolated qualification marker', { flag: 'wx' });
try {
  await app.ready();
  const store = app.getDecorator('getResourceStore')();
  await assert.rejects(
    completeBootstrap({ app, coreRoot, corePlan }),
    /Authenticated official resource cache/,
  );
  assert.equal(app.getDecorator('getResourceStore')(), store);
  assert.equal(store.getStatus('official:epl-default').activeVersion, null);
  await assert.rejects(
    completeBootstrap({
      app,
      coreRoot,
      corePlan: { ...corePlan, contentDigest: '0'.repeat(64) },
    }),
    /Installed Core identity/,
  );
  console.log(
    'PASS: real published Core passes payload verification; same App Store remains missing and completion is denied',
  );
  console.log('PASS: authenticated Core plan mismatch cannot reach resource completion');
} finally {
  await app.close();
  if (!existingMarker) await rm(marker);
  await rm(root, { recursive: true, force: true });
}
