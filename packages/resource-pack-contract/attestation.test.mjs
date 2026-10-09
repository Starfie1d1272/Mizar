import { describe, expect, it } from 'vitest';
import { Buffer } from 'node:buffer';
import { readFile } from 'node:fs/promises';
import { URL } from 'node:url';
import { bundleFromJSON } from '@sigstore/bundle';
import { TrustedRoot } from '@sigstore/protobuf-specs';
import { Verifier, toSignedEntity, toTrustMaterial } from '@sigstore/verify';
import { verifyMizarAttestation, signerIdentity, mizarCertificatePolicy } from './attestation.mjs';
const fixture = new URL('../../apps/companion/test/fixtures/updates/', import.meta.url);
async function signedFixture(
  role = 'qualification',
  sha = 'e46dcf7ff5bf01703da2ee40491f503d1fc4d76b',
) {
  // 既有正式 v1.0.0 的真实证据与 Sigstore 公开根，无测试私钥、假签名或 mock verifier。
  const root = TrustedRoot.fromJSON(
    JSON.parse(await readFile(new URL('trusted_root.json', fixture), 'utf8')),
  );
  const engine = new Verifier(toTrustMaterial(root), { tlogThreshold: 1, ctlogThreshold: 1 });
  const policy = mizarCertificatePolicy(role, sha);
  return {
    bytes: await readFile(new URL('distribution-manifest.json', fixture)),
    bundle: JSON.parse(await readFile(new URL('distribution.attestation.json', fixture), 'utf8')),
    verifier: {
      verify(bundle) {
        return engine.verify(toSignedEntity(bundleFromJSON(bundle)), {
          subjectAlternativeName: policy.certificateIdentityURI,
          oids: Object.entries(policy.certificateOIDs).map(([oid, value]) => ({
            oid: { id: oid.split('.').map(Number) },
            value: Buffer.from(value),
          })),
          extensions: { issuer: 'https://token.actions.githubusercontent.com' },
        });
      },
    },
  };
}
describe('资源与既有更新共用的真实 Sigstore 信任策略', () => {
  it('核验既有正式 Release 的证书、透明日志、subject 与 main 源码', async () => {
    const { bytes, bundle, verifier } = await signedFixture();
    expect(verifyMizarAttestation(bytes, 'distribution-manifest.json', bundle, verifier)).toBe(
      'e46dcf7ff5bf01703da2ee40491f503d1fc4d76b',
    );
  });
  it('拒绝资格证据冒充晋级授权、错资源名、换下载字节和改签名信封', async () => {
    const { bytes, bundle, verifier } = await signedFixture();
    const promotion = await signedFixture('promotion');
    const wrongSha = await signedFixture('qualification', 'a'.repeat(40));
    expect(() =>
      verifyMizarAttestation(bytes, 'distribution-manifest.json', bundle, wrongSha.verifier),
    ).toThrow();
    expect(() =>
      verifyMizarAttestation(
        bytes,
        'distribution-manifest.json',
        bundle,
        promotion.verifier,
        'promotion',
      ),
    ).toThrow();
    expect(() =>
      verifyMizarAttestation(bytes, 'resource-publication.json', bundle, verifier),
    ).toThrow(/subject/);
    expect(() =>
      verifyMizarAttestation(
        Buffer.from('changed'),
        'distribution-manifest.json',
        bundle,
        verifier,
      ),
    ).toThrow(/subject/);
    const changed = JSON.parse(JSON.stringify(bundle));
    changed.dsseEnvelope.payload = Buffer.from('{}').toString('base64');
    expect(() =>
      verifyMizarAttestation(bytes, 'distribution-manifest.json', changed, verifier),
    ).toThrow();
    expect(() => signerIdentity('untrusted')).toThrow();
    const pattern = new RegExp(
      mizarCertificatePolicy('qualification', 'a'.repeat(40)).certificateIdentityURI,
    );
    expect(pattern.test(signerIdentity('qualification'))).toBe(true);
    expect(pattern.test(`${signerIdentity('qualification')}-untrusted`)).toBe(false);
    expect(pattern.test(`evil-${signerIdentity('qualification')}`)).toBe(false);
  });
});
