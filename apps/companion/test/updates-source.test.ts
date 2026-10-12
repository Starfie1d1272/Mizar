import { readFile } from 'node:fs/promises';
import { bundleFromJSON } from '@sigstore/bundle';
import { TrustedRoot } from '@sigstore/protobuf-specs';
import { Verifier, toSignedEntity, toTrustMaterial } from '@sigstore/verify';
import type { Bundle, BundleVerifier } from 'sigstore';
import { describe, expect, it, vi } from 'vitest';
import { UPDATE_WORKFLOW, PUBLICATION_WORKFLOW } from '../src/updates/contract.js';
import { verifyAttestation } from '../src/updates/source.js';

vi.mock('sigstore', () => ({ createVerifier: vi.fn() }));

const fixture = new URL('./fixtures/updates/', import.meta.url);
async function signedFixture(identity = UPDATE_WORKFLOW) {
  const root = TrustedRoot.fromJSON(
    JSON.parse(await readFile(new URL('trusted_root.json', fixture), 'utf8')),
  );
  const engine = new Verifier(toTrustMaterial(root), { tlogThreshold: 1, ctlogThreshold: 1 });
  const verifier: BundleVerifier = {
    verify(bundle, data) {
      return engine.verify(toSignedEntity(bundleFromJSON(bundle), data), {
        subjectAlternativeName: identity,
        extensions: { issuer: 'https://token.actions.githubusercontent.com' },
      });
    },
  };
  return {
    verifier,
    bundle: JSON.parse(
      await readFile(new URL('distribution.attestation.json', fixture), 'utf8'),
    ) as Bundle,
    bytes: await readFile(new URL('distribution-manifest.json', fixture)),
  };
}
describe('actual qualified Release provenance', () => {
  it('accepts the real v1.0.0 subject, certificate and transparency evidence', async () => {
    const { verifier, bundle, bytes } = await signedFixture();
    expect(() =>
      verifyAttestation(bytes, 'distribution-manifest.json', bundle, verifier),
    ).not.toThrow();
  });
  it('rejects a different signing workflow, altered envelope and replaced download bytes', async () => {
    const { verifier, bundle, bytes } = await signedFixture();
    const other = await signedFixture(
      UPDATE_WORKFLOW.replace('refs/heads/main', 'refs/heads/untrusted'),
    );
    expect(() =>
      verifyAttestation(bytes, 'distribution-manifest.json', bundle, other.verifier),
    ).toThrow();
    const publicationOnly = await signedFixture(PUBLICATION_WORKFLOW);
    expect(() =>
      verifyAttestation(
        bytes,
        'distribution-manifest.json',
        bundle,
        publicationOnly.verifier,
        'promotion',
      ),
    ).toThrow();
    expect(() =>
      verifyAttestation(Buffer.from('forged'), 'distribution-manifest.json', bundle, verifier),
    ).toThrow('update_subject_mismatch');
    const changed = structuredClone(bundle) as Bundle & { dsseEnvelope: { payload: string } };
    changed.dsseEnvelope.payload = Buffer.from('{}').toString('base64');
    expect(() =>
      verifyAttestation(bytes, 'distribution-manifest.json', changed, verifier),
    ).toThrow();
  });
});
