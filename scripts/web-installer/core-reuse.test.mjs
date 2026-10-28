import { Buffer } from 'node:buffer';
import { generateKeyPairSync, sign, verify } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { buildOfficialPack, jsonBytes, sha256 } from '../../scripts/asset-packs/pack.mjs';
import { makePublication } from '../../scripts/qualification/resource-provenance/create.mjs';
import {
  createResourceDescriptor,
  createResourceCatalog,
} from '../../packages/resource-pack-contract/catalog.mjs';
import {
  verifyResourceCatalogBytes,
  getResourceAuthorization,
} from '@mizar/resource-pack-contract/runtime';
import { ResourceStore } from '../../apps/companion/src/resource-store/store.ts';
import { createRuntimeVerifier } from '../../apps/companion/src/resource-store/runtime-adapter.ts';
import { installOfficialPack } from '../../scripts/web-installer/install-official-pack.mjs';

// Independent cryptographic test signers. Production fixed Fulcio/TUF/CT/tlog
// verification is unchanged and is exercised by Qualification after real signing.
// These mocks replace only test trust transport; DSSE signatures and all original
// subject/source/catalog/publication/cache/content checks run for every operation.
const fixture = vi.hoisted(() => ({ keys: new Map() }));
function pae(bundle) {
  const envelope = bundle.dsseEnvelope;
  const payload = Buffer.from(envelope.payload, 'base64');
  return Buffer.concat([
    Buffer.from(
      `DSSEv1 ${Buffer.byteLength(envelope.payloadType)} ${envelope.payloadType} ${payload.length} `,
    ),
    payload,
  ]);
}
function verifier(role, sha) {
  return {
    verify(bundle) {
      const key = fixture.keys.get(role + sha);
      if (
        !key ||
        !verify(
          null,
          pae(bundle),
          key.publicKey,
          Buffer.from(bundle.dsseEnvelope.signatures[0].sig, 'base64'),
        )
      )
        throw new Error('Independent test signature rejected');
    },
  };
}
vi.mock('../../packages/resource-pack-contract/dist/attestation.js', async (original) => ({
  ...(await original()),
  createMizarVerifier: async (role, sha) => verifier(role, sha),
}));
vi.mock('../../packages/resource-pack-contract/dist/trust-snapshot.js', async (original) => ({
  ...(await original()),
  captureTrustSnapshot: async () => ({ schemaVersion: 'independent-test-keys' }),
  createOfflineMizarVerifier: (_trust, role, sha) => verifier(role, sha),
}));
function proof(bytes, name, role, sha) {
  const identity = role + sha;
  if (!fixture.keys.has(identity)) fixture.keys.set(identity, generateKeyPairSync('ed25519'));
  const statement = {
    _type: 'https://in-toto.io/Statement/v1',
    predicateType: 'https://slsa.dev/provenance/v1',
    subject: [{ name, digest: { sha256: sha256(bytes) } }],
    predicate: {
      buildDefinition: {
        externalParameters: {
          workflow: {
            repository: 'https://github.com/Starfie1d1272/Mizar',
            path: `.github/workflows/release-${role}.yml`,
            ref: 'refs/heads/main',
          },
        },
        resolvedDependencies: [
          {
            uri: 'git+https://github.com/Starfie1d1272/Mizar@refs/heads/main',
            digest: { gitCommit: sha },
          },
        ],
      },
    },
  };
  const bundle = {
    dsseEnvelope: {
      payloadType: 'application/vnd.in-toto+json',
      payload: jsonBytes(statement).toString('base64'),
      signatures: [{ sig: '' }],
    },
  };
  bundle.dsseEnvelope.signatures[0].sig = sign(
    null,
    pae(bundle),
    fixture.keys.get(identity).privateKey,
  ).toString('base64');
  return jsonBytes(bundle);
}
let pack, root, store;
const sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const oldCore = {
  appVersion: '1.1.0',
  gitSha: sourceSha,
  archive: 'Mizar-v1.1.0-Windows-x64.zip',
  archiveSha256: 'a'.repeat(64),
};
const newCore = {
  appVersion: '1.2.0',
  gitSha: 'c'.repeat(40),
  archive: 'Mizar-v1.2.0-Windows-x64-Core.zip',
  archiveSha256: 'd'.repeat(64),
};
const oldPromotion = 'b'.repeat(40),
  newPromotion = 'e'.repeat(40);
const now = Math.floor(Date.now() / 1000) * 1000;
const instant = (time) => new Date(time).toISOString().replace('.000Z', 'Z');
let statement, statementBytes, oldAuthorization;
async function authorize(core, origin, clock = now) {
  const descriptor = createResourceDescriptor({
    core,
    packVersion: pack.manifest.packVersion,
    archive: statement.archive,
    manifestSha256: pack.manifestSha256,
    sequence: origin?.publication ? 8 : statement.sequence,
    issuedAt: instant(clock - 1000),
    expiresAt: instant(clock + 86400000),
    ...(origin ? { origin } : {}),
  });
  const descriptorBytes = jsonBytes(descriptor);
  const promotion = origin ? newPromotion : oldPromotion;
  const catalogBytes = jsonBytes(
    createResourceCatalog(descriptor, descriptorBytes, promotion, sha256(statementBytes)),
  );
  return verifyResourceCatalogBytes({
    descriptorBytes,
    descriptorBundleBytes: proof(
      descriptorBytes,
      'resource-descriptor.json',
      'qualification',
      core.gitSha,
    ),
    catalogBytes,
    catalogBundleBytes: proof(catalogBytes, 'resource-catalog.json', 'promotion', promotion),
    expectedCore: core,
    tufCachePath: join(root, 'trust'),
  });
}
const origin = () => ({
  sourceSha,
  publication: {
    promotionSha: oldPromotion,
    releaseVersion: oldCore.appVersion,
    sha256: sha256(statementBytes),
    sequence: statement.sequence,
    issuedAt: statement.issuedAt,
    expiresAt: statement.expiresAt,
  },
});
async function open(core) {
  store = await ResourceStore.open({
    root: join(root, 'store'),
    verifyTrustedPack: createRuntimeVerifier(undefined, [], core),
    activateWhenSafe: async (commit) => {
      await commit();
      return true;
    },
  });
  return store;
}
beforeAll(async () => {
  root = await mkdtemp(join(await realpath(tmpdir()), 'mizar-signed-reuse-'));
  pack = await buildOfficialPack(process.cwd(), { packVersion: '1.0.0', sourceSha });
  statement = makePublication(pack, {
    promotionSha: oldPromotion,
    sequence: 7,
    issuedAt: instant(now - 1000),
    expiresAt: instant(now + 86400000),
  });
  statementBytes = jsonBytes(statement);
  oldAuthorization = await authorize(oldCore);
}, 30000);
afterAll(async () => {
  vi.useRealTimers();
  await store?.close();
  await rm(root, { recursive: true, force: true });
});
describe('signed content retained across compatible Core authorization', () => {
  it('installs once, reopens on a different Core with zero ZIP loads, and preserves the old Core receipt on rollback', async () => {
    const firstZip = vi.fn(async () => ({
      statementBytes,
      publicationBundleBytes: proof(
        statementBytes,
        'resource-publication.json',
        'promotion',
        oldPromotion,
      ),
      archiveBytes: pack.archiveBytes,
      archiveBundleBytes: proof(
        pack.archiveBytes,
        statement.archive.name,
        'qualification',
        sourceSha,
      ),
    }));
    await installOfficialPack({
      store: await open(oldCore),
      authorization: oldAuthorization,
      loadInputs: firstZip,
      tufCachePath: join(root, 'trust'),
    });
    expect(firstZip).toHaveBeenCalledTimes(1);
    await store.close();
    // Renew compatibility after the old publication has expired. Its original
    // dates, source and Promotion signature remain byte-for-byte unchanged.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now + 2 * 86400000);
    for (const suffix of ['', '-rc.3']) {
      const core = {
        ...newCore,
        appVersion: `1.2.0${suffix}`,
        archive: `Mizar-v1.2.0${suffix}-Windows-x64-Core.zip`,
      };
      const authorization = await authorize(core, origin(), now + 2 * 86400000);
      const zip = vi.fn(async () => {
        throw new Error('resource ZIP must not be requested');
      });
      const opened = await open(core);
      const result = await installOfficialPack({
        store: opened,
        authorization,
        loadInputs: zip,
        tufCachePath: join(root, 'trust'),
      });
      expect(zip).not.toHaveBeenCalled();
      expect(result.sourceSha).toBe(sourceSha);
      expect(result.promotionSha).toBe(oldPromotion);
      expect(getResourceAuthorization(authorization).core.gitSha).toBe(core.gitSha);
      expect(
        getResourceAuthorization(authorization).originAssets['resource-publication.json'],
      ).toBe(
        'https://github.com/Starfie1d1272/Mizar/releases/download/v1.1.0/resource-publication.json',
      );
      await store.close();
    }
    const oldStore = await open(oldCore);
    expect(oldStore.getStatus('official:epl-default').phase).toBe('ready');
    const path = join(root, 'store', sha256(Buffer.from('official:epl-default')), 'versions');
    const { readdir } = await import('node:fs/promises');
    const ids = await readdir(path);
    const receipt = JSON.parse(await readFile(join(path, ids[0], 'receipt.json'), 'utf8'));
    const primary = JSON.parse(Buffer.from(receipt.catalog.descriptorBase64, 'base64').toString());
    expect(primary.core.gitSha).toBe(oldCore.gitSha);
    expect(receipt.publicationBase64).toBe(statementBytes.toString('base64'));
    await store.close();
    vi.useRealTimers();
  }, 30000);
});
