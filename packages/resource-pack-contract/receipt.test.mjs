import { describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { Buffer } from 'node:buffer';
import { URL } from 'node:url';
import {
  createOfflineMizarVerifier,
  verifyTrustSnapshot,
  verifyFreshTrustSnapshot,
} from './trust-snapshot.mjs';
import { verifyMizarAttestation, verifyMizarAttestationDigest } from './attestation.mjs';
import { verifyResourceReceipt } from './runtime.mjs';
import { parsePublication } from './publication.mjs';
const encode = (bytes) => bytes.toString('base64');
const sourceSha = 'e46dcf7ff5bf01703da2ee40491f503d1fc4d76b';
async function evidence() {
  const root = new URL('./test-fixtures/tuf/', import.meta.url),
    release = new URL('../../apps/companion/test/fixtures/updates/', import.meta.url);
  return {
    trust: {
      schemaVersion: 'mizar.sigstore-cache.v1',
      rootChain: [],
      targetsBase64: encode(await readFile(new URL('targets.json', root))),
      trustedRootBase64: encode(await readFile(new URL('trusted_root.json', root))),
    },
    bundle: JSON.parse(await readFile(new URL('distribution.attestation.json', release), 'utf8')),
    bytes: await readFile(new URL('distribution-manifest.json', release)),
  };
}
describe('固定 Sigstore 根的离线缓存证据', () => {
  it('禁网仍能验证真实签名、透明日志、main 证书与不保留 ZIP 的 digest subject', async () => {
    const { trust, bytes, bundle } = await evidence();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2040-01-01T00:00:00Z'));
    const network = vi.fn(() => {
      throw new Error('离线请求不允许');
    });
    vi.stubGlobal('fetch', network);
    try {
      const verifier = createOfflineMizarVerifier(trust, 'qualification', sourceSha);
      expect(verifyMizarAttestation(bytes, 'distribution-manifest.json', bundle, verifier)).toBe(
        sourceSha,
      );
      expect(
        verifyMizarAttestationDigest(
          'a2f5d3cdc2d6c7921aa54071f67ed687f48cbce5f3f96c394aec41dabd1587bc',
          'distribution-manifest.json',
          bundle,
          verifier,
        ),
      ).toBe(sourceSha);
      expect(() =>
        verifyMizarAttestationDigest(
          'a'.repeat(64),
          'distribution-manifest.json',
          bundle,
          verifier,
        ),
      ).toThrow(/subject/);
      expect(network).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });
  it('receipt 自带 hash 或根不能授权：拒绝改 target、改材料、替换 root 与错证书角色', async () => {
    const { trust, bytes, bundle } = await evidence();
    const changed = JSON.parse(Buffer.from(trust.targetsBase64, 'base64'));
    changed.signed.targets['trusted_root.json'].hashes.sha256 = 'a'.repeat(64);
    expect(() =>
      verifyTrustSnapshot({
        ...trust,
        targetsBase64: encode(Buffer.from(JSON.stringify(changed))),
      }),
    ).toThrow();
    expect(() =>
      verifyTrustSnapshot({ ...trust, trustedRootBase64: encode(Buffer.from('{}')) }),
    ).toThrow(/target/);
    expect(() =>
      verifyTrustSnapshot({ ...trust, rootChain: [encode(Buffer.from('{}'))] }),
    ).toThrow();
    const verifier = createOfflineMizarVerifier(trust, 'promotion', sourceSha);
    expect(() =>
      verifyMizarAttestation(bytes, 'resource-publication.json', bundle, verifier, 'promotion'),
    ).toThrow();
  });
  it('无 ZIP 的 cache API 对无签发行声明仍在密码学边界拒绝且不联网', async () => {
    const { trust, bundle } = await evidence();
    const statement = {
      schemaVersion: 'mizar.resource-publication.v1',
      repository: 'Starfie1d1272/Mizar',
      packId: 'official:epl-default',
      packVersion: '1.0.0',
      sourceRef: 'refs/heads/main',
      sourceSha,
      promotionSha: sourceSha,
      contentKind: 'recorded-replay',
      compatibility: {
        resourceSchemaVersion: 1,
        minimumCoreVersion: '1.1.0',
        maximumCoreVersionExclusive: '2.0.0',
      },
      manifestSha256: 'a'.repeat(64),
      archive: {
        name: 'Mizar-official-epl-default-1.0.0.zip',
        format: 'zip',
        bytes: 100,
        sha256: 'b'.repeat(64),
      },
      sequence: 1,
      issuedAt: '2026-10-09T01:00:00Z',
      expiresAt: '2026-10-10T01:00:00Z',
    };
    const receipt = {
      schemaVersion: 'mizar.resource-receipt.v1',
      publicationBase64: encode(Buffer.from(JSON.stringify(statement))),
      manifestBase64: encode(Buffer.from('{}')),
      publicationBundleBase64: encode(Buffer.from(JSON.stringify(bundle))),
      archiveBundleBase64: encode(Buffer.from(JSON.stringify(bundle))),
      trust,
    };
    const network = vi.fn(() => {
      throw new Error('离线请求不允许');
    });
    vi.stubGlobal('fetch', network);
    try {
      await expect(
        verifyResourceReceipt({
          receipt,
          purpose: 'cache',
          policy: {
            packVersion: '1.0.0',
            sourceSha,
            promotionSha: sourceSha,
            coreVersion: '1.1.0',
            minimumSequence: 99,
            now: Date.parse('2027-01-01T00:00:00Z'),
          },
        }),
      ).rejects.toThrow(/certificate identity/);
      expect(network).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it('历史缓存允许声明到期/回退，但新安装和迁移继续拒绝过期与旧序号', () => {
    const statement = {
      schemaVersion: 'mizar.resource-publication.v1',
      repository: 'Starfie1d1272/Mizar',
      packId: 'official:epl-default',
      packVersion: '1.0.0',
      sourceRef: 'refs/heads/main',
      sourceSha,
      promotionSha: sourceSha,
      contentKind: 'recorded-replay',
      compatibility: {
        resourceSchemaVersion: 1,
        minimumCoreVersion: '1.1.0',
        maximumCoreVersionExclusive: '2.0.0',
      },
      manifestSha256: 'a'.repeat(64),
      archive: {
        name: 'Mizar-official-epl-default-1.0.0.zip',
        format: 'zip',
        bytes: 100,
        sha256: 'b'.repeat(64),
      },
      sequence: 1,
      issuedAt: '2026-10-09T01:00:00Z',
      expiresAt: '2026-10-10T01:00:00Z',
    };
    const policy = {
      packVersion: '1.0.0',
      sourceSha,
      promotionSha: sourceSha,
      coreVersion: '1.1.0',
      minimumSequence: 2,
      now: Date.parse('2027-01-01T00:00:00Z'),
    };
    for (const purpose of ['cache', 'rollback'])
      expect(parsePublication(statement, policy, { purpose })).toBe(statement);
    for (const purpose of ['install', 'legacy'])
      expect(() => parsePublication(statement, policy, { purpose })).toThrow();
    expect(() =>
      parsePublication(statement, { ...policy, minimumSequence: 0 }, { purpose: 'install' }),
    ).toThrow(/过期/);
  });
});

it('requires fresh signed TUF roles for first installation while preserving historical cache verification', async () => {
  const { trust, bytes, bundle } = await evidence();
  const fixture = new URL('./test-fixtures/tuf/', import.meta.url);
  const fresh = {
    ...trust,
    timestampBase64: encode(await readFile(new URL('first-install-timestamp.json', fixture))),
    snapshotBase64: encode(await readFile(new URL('first-install-snapshot.json', fixture))),
    targetsBase64: encode(await readFile(new URL('first-install-targets.json', fixture))),
  };
  const network = vi.fn(() => {
    throw new Error('Offline network denied');
  });
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-10T12:00:00Z'));
  vi.stubGlobal('fetch', network);
  try {
    const verifier = createOfflineMizarVerifier(fresh, 'qualification', sourceSha, {
      firstInstall: true,
    });
    expect(verifyMizarAttestation(bytes, 'distribution-manifest.json', bundle, verifier)).toBe(
      sourceSha,
    );
    expect(() => verifyFreshTrustSnapshot(trust)).toThrow();
    expect(() =>
      verifyFreshTrustSnapshot({ ...fresh, snapshotBase64: trust.targetsBase64 }),
    ).toThrow();
    const expiredAt = Math.min(
      ...[
        JSON.parse(Buffer.from(fresh.timestampBase64, 'base64')),
        JSON.parse(Buffer.from(fresh.snapshotBase64, 'base64')),
        JSON.parse(Buffer.from(fresh.targetsBase64, 'base64')),
      ].map((role) => Date.parse(role.signed.expires)),
    );
    vi.setSystemTime(new Date(expiredAt));
    expect(() =>
      createOfflineMizarVerifier(fresh, 'qualification', sourceSha, { firstInstall: true }),
    ).toThrow('expired');
    expect(
      verifyMizarAttestation(
        bytes,
        'distribution-manifest.json',
        bundle,
        createOfflineMizarVerifier(trust, 'qualification', sourceSha),
      ),
    ).toBe(sourceSha);
    expect(network).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  }
});
