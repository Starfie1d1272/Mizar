import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { pathToFileURL, URL } from 'node:url';
import { resolve } from 'node:path';

// Point at the deployed bridge to exercise the registered package's real exports.
// A ready status double models the untrusted version-only shortcut. No signature,
// authorization, installation, or offline success is mocked or claimed here.
const moduleUrl = process.argv[2]
  ? pathToFileURL(resolve(process.argv[2])).href
  : new URL('./install-official-pack.mjs', import.meta.url).href;
const { installOfficialPack } = await import(moduleUrl);
let reads = 0;
let installs = 0;
let verifications = 0;
const store = {
  getStatus: () => ({ phase: 'ready', activeVersion: '1.0.0', preparedVersion: null }),
  reuseActive: async (_packId, verifyIdentity, { signal }) => {
    verifications += 1;
    const statement = {
      schemaVersion: 'mizar.resource-publication.v1',
      repository: 'Starfie1d1272/Mizar',
      packId: 'official:epl-default',
      packVersion: '1.0.0',
      sourceRef: 'refs/heads/main',
      sourceSha: '3'.repeat(40),
      promotionSha: '2'.repeat(40),
      contentKind: 'recorded-replay',
    };
    // Real SDK authorization must reject this same-version, wrong-source receipt.
    return verifyIdentity({
      receipt: {
        schemaVersion: 'mizar.resource-receipt.v1',
        publicationBase64: Buffer.from(JSON.stringify(statement)).toString('base64'),
        manifestBase64: Buffer.from('{}').toString('base64'),
      },
      signal,
    });
  },
  read: async () => {
    reads += 1;
    return { bytes: Buffer.from('previous trusted contents') };
  },
  installVerified: async () => {
    installs += 1;
    throw new Error('Unauthenticated installation must never begin');
  },
};
await assert.rejects(
  installOfficialPack({
    store,
    inputs: {},
    policy: {
      packVersion: '1.0.0',
      sourceSha: '1'.repeat(40),
      promotionSha: '2'.repeat(40),
      coreVersion: '1.1.0',
      minimumSequence: 0,
    },
  }),
  /发行声明身份/,
);
assert.equal(verifications, 1, 'Store must invoke real target identity verification');
assert.equal(reads, 0, 'Same-version bytes must not bypass target authorization');
assert.equal(installs, 0, 'No unverified inputs may reach Store installation');
console.log('PASS: ready same-version status cannot bypass target authorization');
