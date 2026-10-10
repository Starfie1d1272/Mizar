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
let downloads = 0;
const store = {
  getStatus: () => ({ phase: 'ready', activeVersion: '1.0.0', preparedVersion: null }),
  reuseActive: async () => {
    verifications += 1;
    throw new Error('Unauthenticated cache lookup');
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
    loadInputs: async () => {
      downloads += 1;
      throw new Error('Unverified policy must not download a ZIP');
    },
    authorization: {
      schemaVersion: 'mizar.authenticated-resource-catalog.v1',
      policy: {
        packVersion: '1.0.0',
        sourceSha: '1'.repeat(40),
        promotionSha: '2'.repeat(40),
        coreVersion: '1.1.0',
        minimumSequence: 0,
      },
    },
  }),
  /必须先认证/,
);
assert.equal(verifications, 0, 'Unverified catalog policy must not reach Store');
assert.equal(reads, 0, 'Same-version bytes must not bypass target authorization');
assert.equal(installs, 0, 'No unverified inputs may reach Store installation');
assert.equal(downloads, 0, 'No unverified catalog may initiate resource downloads');
console.log('PASS: ready same-version status cannot bypass target authorization');
