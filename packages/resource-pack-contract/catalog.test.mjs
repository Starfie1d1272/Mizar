import { Buffer } from 'node:buffer';
import { readFile } from 'node:fs/promises';
import { URL } from 'node:url';
import { describe, it, expect, vi } from 'vitest';
import {
  createResourceDescriptor,
  createResourceCatalog,
  parseResourceCatalogBytes,
} from './catalog.mjs';
import { jsonBytes } from './content.mjs';
import {
  getResourceAuthorization,
  verifyResourceCatalogReceipt,
  verifyResourceReceipt,
} from './runtime.mjs';

const sourceSha = 'e46dcf7ff5bf01703da2ee40491f503d1fc4d76b';
const core = {
  appVersion: '1.1.0',
  gitSha: sourceSha,
  archive: 'Mizar-v1.1.0-Windows-x64.zip',
  archiveSha256: 'a'.repeat(64),
};
function candidate() {
  // Canonical structural data only; no claimed signing or trusted policy.
  const descriptor = createResourceDescriptor({
    core,
    packVersion: '1.0.0',
    archive: {
      name: 'Mizar-official-epl-default-1.0.0.zip',
      bytes: 100,
      sha256: 'b'.repeat(64),
      format: 'zip',
    },
    manifestSha256: 'c'.repeat(64),
    sequence: 7,
    issuedAt: '2026-01-01T00:00:00Z',
    expiresAt: '2026-04-01T00:00:00Z',
  });
  const descriptorBytes = jsonBytes(descriptor);
  const catalog = createResourceCatalog(descriptor, descriptorBytes, sourceSha, 'd'.repeat(64));
  return { descriptor, descriptorBytes, catalog, catalogBytes: jsonBytes(catalog) };
}
describe('original Qualification descriptor and Promotion catalog client boundary', () => {
  it('rejects changed Core/ZIP, addresses, original bytes, policy and extra or duplicate fields', () => {
    const c = candidate();
    expect(
      parseResourceCatalogBytes(c.descriptorBytes, c.catalogBytes, core).entry.assets[
        'resource-pack-provenance.json'
      ],
    ).toBe(
      'https://github.com/Starfie1d1272/Mizar/releases/download/v1.1.0/resource-pack-provenance.json',
    );
    expect(() =>
      parseResourceCatalogBytes(c.descriptorBytes, c.catalogBytes, {
        ...core,
        archiveSha256: 'e'.repeat(64),
      }),
    ).toThrow('Core');
    for (const edit of [
      (v) => {
        v.resources[0].assets['resource-catalog.json'] = 'https://evil.invalid/catalog';
      },
      (v) => {
        v.resources[0].policy.minimumSequence = 1;
      },
      (v) => {
        v.descriptorSha256 = 'e'.repeat(64);
      },
      (v) => {
        v.trusted = true;
      },
    ]) {
      const changed = globalThis.structuredClone(c.catalog);
      edit(changed);
      expect(() => parseResourceCatalogBytes(c.descriptorBytes, jsonBytes(changed), core)).toThrow(
        '规范字节',
      );
    }
    expect(() =>
      parseResourceCatalogBytes(
        Buffer.from(
          c.descriptorBytes
            .toString()
            .replace('"repository":', '"repository":"duplicate", "repository":'),
        ),
        c.catalogBytes,
        core,
      ),
    ).toThrow('规范字节');
    expect(() =>
      getResourceAuthorization({
        ...c.catalog,
        schemaVersion: 'mizar.authenticated-resource-catalog.v1',
      }),
    ).toThrow('必须先认证');
  });
  it('requires real fixed-root original descriptor proof offline, including expired cached catalogs', async () => {
    const c = candidate(),
      fixture = new URL('../../apps/companion/test/fixtures/updates/', import.meta.url);
    const proof = await readFile(new URL('distribution.attestation.json', fixture));
    const receipt = {
      schemaVersion: 'mizar.resource-catalog-receipt.v1',
      descriptorBase64: c.descriptorBytes.toString('base64'),
      descriptorBundleBase64: proof.toString('base64'),
      catalogBase64: c.catalogBytes.toString('base64'),
      catalogBundleBase64: proof.toString('base64'),
      trust: {
        schemaVersion: 'mizar.sigstore-cache.v1',
        rootChain: [],
        targetsBase64: (
          await readFile(new URL('./test-fixtures/tuf/targets.json', import.meta.url))
        ).toString('base64'),
        trustedRootBase64: (
          await readFile(new URL('./test-fixtures/tuf/trusted_root.json', import.meta.url))
        ).toString('base64'),
      },
    };
    const network = vi.fn(() => {
      throw new Error('offline test must never fetch');
    });
    vi.stubGlobal('fetch', network);
    try {
      // This existing genuine main Qualification signature is for distribution-manifest,
      // not the new descriptor. Reaching subject rejection proves actual cryptography ran.
      await expect(
        verifyResourceCatalogReceipt({ receipt, expectedCore: core, purpose: 'cache' }),
      ).rejects.toThrow('subject');
      await expect(
        verifyResourceReceipt({
          receipt: { schemaVersion: 'mizar.resource-receipt.v1', catalog: receipt },
          expectedCore: core,
          purpose: 'cache',
        }),
      ).rejects.toThrow('subject');
      await expect(
        verifyResourceCatalogReceipt({ receipt, expectedCore: core, purpose: 'install' }),
      ).rejects.toThrow('过期');
      expect(network).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
