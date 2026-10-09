import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
const root = await mkdtemp(join(tmpdir(), 'mizar-bootstrap-boundary-'));
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
await writeFile(marker, 'isolated qualification marker', { flag: 'wx' });
try {
  await app.ready();
  const store = app.getDecorator('getResourceStore')();
  await assert.rejects(
    completeBootstrap({ app, coreRoot, corePlan, policy }),
    /Official resource input/,
  );
  assert.equal(app.getDecorator('getResourceStore')(), store);
  assert.equal(store.getStatus('official:epl-default').activeVersion, null);
  await assert.rejects(
    completeBootstrap({
      app,
      coreRoot,
      corePlan: { ...corePlan, contentDigest: '0'.repeat(64) },
      policy,
    }),
    /Installed Core identity/,
  );
  console.log(
    'PASS: real published Core passes payload verification; same App Store remains missing and completion is denied',
  );
  console.log('PASS: authenticated Core plan mismatch cannot reach resource completion');
} finally {
  await app.close();
  await rm(marker);
  await rm(root, { recursive: true, force: true });
}
