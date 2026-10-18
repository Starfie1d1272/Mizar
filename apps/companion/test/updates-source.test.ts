import { readFile } from 'node:fs/promises';
import { bundleFromJSON } from '@sigstore/bundle';
import { TrustedRoot } from '@sigstore/protobuf-specs';
import { Verifier, toSignedEntity, toTrustMaterial } from '@sigstore/verify';
import type { Bundle, BundleVerifier } from 'sigstore';
import { describe, expect, it, vi } from 'vitest';
import { UPDATE_WORKFLOW, PUBLICATION_WORKFLOW } from '../src/updates/contract.js';
import { StableSource, verifyAttestation } from '../src/updates/source.js';
import { updateManifestSchema, updatePublicationSchema } from '../src/updates/contract.js';

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

it('filters mixed and mislabeled prereleases before any update asset download', async () => {
  const stable = {
    tag_name: 'v1.5.0',
    draft: false,
    prerelease: false,
    published_at: '2026-10-17T00:00:00Z',
    assets: [],
  };
  const rejected = [
    ...['alpha.1', 'beta.2', 'rc.3'].flatMap((suffix) =>
      [true, false].map((prerelease) => ({ ...stable, tag_name: `v2.0.0-${suffix}`, prerelease })),
    ),
    { ...stable, tag_name: 'v3.0.0', prerelease: true },
    { ...stable, tag_name: 'v4.0.0', draft: true },
  ];
  const fetcher = vi.fn(() => Promise.resolve(new Response(JSON.stringify([...rejected, stable]))));
  const source = new StableSource('unused-cache', fetcher, 'github');
  expect((await source.latest(new AbortController().signal))?.tag_name).toBe('v1.5.0');
  fetcher.mockImplementation(() => Promise.resolve(new Response(JSON.stringify(rejected))));
  expect(await source.latest(new AbortController().signal)).toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(2);
  for (const suffix of ['alpha.1', 'beta.2', 'rc.3']) {
    expect(updateManifestSchema.shape.version.safeParse(`2.0.0-${suffix}`).success).toBe(false);
    expect(updatePublicationSchema.shape.version.safeParse(`2.0.0-${suffix}`).success).toBe(false);
    expect(updateManifestSchema.shape.channel.safeParse(suffix.split('.')[0]).success).toBe(false);
  }
  expect(updateManifestSchema.shape.channel.safeParse('stable').success).toBe(true);
});
