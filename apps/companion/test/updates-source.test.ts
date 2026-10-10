import { createHash } from 'node:crypto';
import {
  makeMachineMetadata,
  MACHINE_METADATA_NAME,
} from '@mizar/resource-pack-contract/transport';
import { createVerifier } from 'sigstore';
import { readFile } from 'node:fs/promises';
import { bundleFromJSON } from '@sigstore/bundle';
import { TrustedRoot } from '@sigstore/protobuf-specs';
import { Verifier, toSignedEntity, toTrustMaterial } from '@sigstore/verify';
import type { Bundle, BundleVerifier } from 'sigstore';
import { describe, expect, it, vi } from 'vitest';
import {
  compareVersions,
  isCompatible,
  UPDATE_WORKFLOW,
  PUBLICATION_WORKFLOW,
  updateManifestSchema,
  updatePublicationSchema,
} from '../src/updates/contract.js';
import { allowedUpdateUrl, boundedBytes, updateRequest } from '../src/updates/network.js';
import { StableSource, verifyAttestation } from '../src/updates/source.js';
import { BoxSource } from '../src/updates/box.js';

vi.mock('sigstore', () => ({ createVerifier: vi.fn() }));

const fixture = new URL('./fixtures/updates/', import.meta.url);
const fetchUrl = (input: Parameters<typeof fetch>[0]) =>
  typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
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

it('accepts Box only with a separately signed publication bound to the qualified manifest', async () => {
  // Signature cryptography is covered by the real fixture; here we exercise
  // mirror orchestration, both pinned signer policies and independent claims.
  vi.mocked(createVerifier).mockResolvedValue({ verify: vi.fn() });
  const manifest = {
    schemaVersion: 'mizar.update.v1',
    repository: 'Starfie1d1272/Mizar',
    channel: 'stable',
    version: '1.1.0',
    gitSha: 'a'.repeat(40),
    notes: '版本说明',
    compatibility: { minimumVersion: '1.0.0', maximumVersionExclusive: '2.0.0' },
    installer: {
      platform: 'win32-x64',
      format: 'nsis-setup',
      name: 'Mizar-v1.1.0-Windows-x64-Setup.exe',
      bytes: 50,
      sha256: 'b'.repeat(64),
      contentDigest: 'c'.repeat(64),
    },
  };
  const bytes = Buffer.from(JSON.stringify(manifest));
  const publication = {
    schemaVersion: 'mizar.update-publication.v1',
    repository: 'Starfie1d1272/Mizar',
    version: '1.1.0',
    gitSha: manifest.gitSha,
    manifestSha256: createHash('sha256').update(bytes).digest('hex'),
    releaseId: 42,
    publishedAt: '2026-10-10T00:00:00Z',
    promotionSha: 'd'.repeat(40),
  };
  const envelope = (subject: string, data: Buffer, workflow: string, commit: string) => ({
    dsseEnvelope: {
      payloadType: 'application/vnd.in-toto+json',
      payload: Buffer.from(
        JSON.stringify({
          _type: 'https://in-toto.io/Statement/v1',
          subject: [
            { name: subject, digest: { sha256: createHash('sha256').update(data).digest('hex') } },
          ],
          predicateType: 'https://slsa.dev/provenance/v1',
          predicate: {
            buildDefinition: {
              resolvedDependencies: [
                {
                  uri: 'git+https://github.com/Starfie1d1272/Mizar@refs/heads/main',
                  digest: { gitCommit: commit },
                },
              ],
              externalParameters: {
                workflow: {
                  repository: 'https://github.com/Starfie1d1272/Mizar',
                  path: `.github/workflows/release-${workflow}.yml`,
                  ref: 'refs/heads/main',
                },
              },
            },
          },
        }),
      ).toString('base64'),
    },
  });
  const index = (record = publication, workflow = 'promotion') => {
    const receipt = Buffer.from(JSON.stringify(record));
    return {
      schemaVersion: 'mizar.update-index.v2',
      manifestBase64: bytes.toString('base64'),
      provenance: envelope('update-manifest.json', bytes, 'qualification', manifest.gitSha),
      publicationBase64: receipt.toString('base64'),
      publicationProvenance: envelope(
        'update-publication.json',
        receipt,
        workflow,
        publication.promotionSha,
      ),
    };
  };
  let metadata: Record<string, unknown> = index();
  const githubRequests: string[] = [];
  const fetcher: typeof fetch = (input) => {
    const url = fetchUrl(input);
    if (url.includes('api.github.com')) {
      githubRequests.push(url);
      return Promise.resolve(Response.json([]));
    }
    if (url.includes('/dir/'))
      return Promise.resolve(Response.json({ user_perm: 'r', repo_name: 'Mizar' }));
    if (url.includes('/download-link/'))
      return Promise.resolve(
        Response.json('https://box.nju.edu.cn/seafhttp/files/index/latest.json'),
      );
    return Promise.resolve(Response.json(metadata));
  };
  const source = new StableSource('/unused', fetcher),
    signal = new AbortController().signal;
  const release = await source.latest(signal);
  expect(release?.tag_name).toBe('v1.1.0');
  expect(await source.authenticate(release!, signal)).toEqual(manifest);
  expect(githubRequests).toEqual([]);
  expect(createVerifier).toHaveBeenCalledWith(
    expect.objectContaining({
      certificateIdentityURI:
        '^https://github\\.com/Starfie1d1272/Mizar/\\.github/workflows/release-qualification\\.yml@refs/heads/main$',
    }),
  );
  expect(createVerifier).toHaveBeenCalledWith(
    expect.objectContaining({
      certificateIdentityURI:
        '^https://github\\.com/Starfie1d1272/Mizar/\\.github/workflows/release-promotion\\.yml@refs/heads/main$',
      ctLogThreshold: 1,
      tlogThreshold: 1,
    }),
  );
  for (const invalid of [
    {
      ...index(),
      schemaVersion: 'mizar.update-index.v1',
      publicationBase64: undefined,
      publicationProvenance: undefined,
    },
    { ...index(), publicationBase64: undefined },
    index(publication, 'qualification'),
    index({ ...publication, version: '1.2.0' }),
    index({ ...publication, gitSha: 'e'.repeat(40) }),
    index({ ...publication, manifestSha256: 'f'.repeat(64) }),
    index({ ...publication, promotionSha: 'e'.repeat(40) }),
  ]) {
    metadata = invalid;
    expect(await source.latest(signal)).toBeNull();
  }
  expect(githubRequests.length).toBe(7);
});
describe('Stable discovery and bounded requests', () => {
  it('uses the read-only Box API and keeps the credential off temporary downloads and GitHub', async () => {
    const requests: { url: string; authorization: string | null }[] = [];
    const box = new BoxSource((input, init) => {
      const url = fetchUrl(input);
      requests.push({ url, authorization: new Headers(init?.headers).get('authorization') });
      if (url.includes('/dir/'))
        return Promise.resolve(
          Response.json({
            user_perm: 'r',
            repo_name: 'Mizar',
            dirent_list: [{ name: 'Mizar-v1.1.0-Windows-x64-Setup.exe', type: 'file', size: 3 }],
          }),
        );
      return Promise.resolve(
        Response.json('https://box.nju.edu.cn/seafhttp/files/temporary/setup.exe'),
      );
    });
    expect((await box.stable(new AbortController().signal))?.version).toBe('1.1.0');
    const link = await box.link(
      '/Stable/Mizar-v1.1.0-Windows-x64-Setup.exe',
      new AbortController().signal,
    );
    const fetcher: typeof fetch = (input, init) => {
      requests.push({
        url: fetchUrl(input),
        authorization: new Headers(init?.headers).get('authorization'),
      });
      return Promise.resolve(new Response('abc'));
    };
    await updateRequest(link, new AbortController().signal, fetcher);
    await updateRequest(
      'https://api.github.com/repos/Starfie1d1272/Mizar/releases',
      new AbortController().signal,
      fetcher,
    );
    expect(requests.slice(0, 2).every((r) => r.authorization?.startsWith('Token '))).toBe(true);
    expect(requests.slice(2).map((r) => r.authorization)).toEqual([null, null]);
    await expect(
      new BoxSource(() =>
        Promise.resolve(Response.json({ user_perm: 'rw', repo_name: 'Mizar', dirent_list: [] })),
      ).stable(new AbortController().signal),
    ).rejects.toThrow();
    await expect(
      new BoxSource(() =>
        Promise.resolve(Response.json('https://attacker.example/setup.exe')),
      ).link('/Stable/Mizar-v1.1.0-Windows-x64-Setup.exe', new AbortController().signal),
    ).rejects.toThrow('update_mirror_link_invalid');
  });
  it('compares numeric SemVer and excludes drafts and RC releases irrespective of date', async () => {
    const releases = ['v1.2.0', 'v1.10.0', 'v2.0.0-rc.1', 'v2.0.0'].map((tag, i) => ({
      tag_name: tag,
      draft: i === 3,
      prerelease: i === 2,
      published_at: '2026-10-09',
      assets: [],
    }));
    const source = new StableSource('/unused', () => Promise.resolve(Response.json(releases)));
    expect((await source.latest(new AbortController().signal))?.tag_name).toBe('v1.10.0');
    expect(compareVersions('1.10.0', '1.9.99')).toBe(1);
    expect(() => compareVersions('1.0.0-rc.1', '1.0.0')).toThrow();
    expect(() => compareVersions('01.0.0', '1.0.0')).toThrow();
  });
  it('rejects source-controlled redirects and oversized streaming responses', async () => {
    for (const url of [
      'http://github.com/Starfie1d1272/Mizar/releases/download/v1.1.0/x',
      'https://github.com/attacker/Mizar/releases/download/v1.1.0/x',
      'https://box.nju.edu.cn/api/v2.1/via-repo-token/file/',
      'https://user:secret@box.nju.edu.cn/seafhttp/files/x',
    ])
      expect(allowedUpdateUrl(new URL(url))).toBe(false);
    let requests = 0;
    await expect(
      updateRequest(
        'https://api.github.com/repos/Starfie1d1272/Mizar/releases',
        new AbortController().signal,
        () => {
          requests++;
          return Promise.resolve(
            new Response(null, {
              status: 302,
              headers: { location: 'https://attacker.example/setup.exe' },
            }),
          );
        },
      ),
    ).rejects.toThrow('update_url_forbidden');
    expect(requests).toBe(1);
    await expect(boundedBytes(new Response('too long'), 3)).rejects.toThrow(
      'update_response_too_large',
    );
  });
  it('binds package names and compatibility to the offered Stable', () => {
    const value = {
      schemaVersion: 'mizar.update.v1',
      repository: 'Starfie1d1272/Mizar',
      channel: 'stable',
      version: '1.1.0',
      gitSha: 'a'.repeat(40),
      notes: '中文更新说明',
      compatibility: { minimumVersion: '1.0.0', maximumVersionExclusive: '2.0.0' },
      installer: {
        platform: 'win32-x64',
        format: 'nsis-setup',
        name: 'Mizar-v1.1.0-Windows-x64-Setup.exe',
        bytes: 50,
        sha256: 'b'.repeat(64),
        contentDigest: 'c'.repeat(64),
      },
    };
    const manifest = updateManifestSchema.parse(value);
    expect(isCompatible('1.0.0', manifest)).toBe(true);
    expect(isCompatible('1.1.0-rc.1', manifest)).toBe(true);
    expect(isCompatible('2.0.0', manifest)).toBe(false);
    expect(
      updateManifestSchema.safeParse({
        ...value,
        installer: { ...value.installer, name: 'Mizar-v1.0.0-Windows-x64-Setup.exe' },
      }).success,
    ).toBe(false);
  });
});

it('binds production authentication to fixed verifier policy, signed source, tag and installer asset', async () => {
  // Cryptographic acceptance/rejection is owned by the real signed fixture above.
  // This seam verifies production orchestration and its mandatory trust policy.
  const verify = vi.fn();
  vi.mocked(createVerifier).mockResolvedValue({ verify });
  const manifest = {
    schemaVersion: 'mizar.update.v1',
    repository: 'Starfie1d1272/Mizar',
    channel: 'stable',
    version: '1.1.0',
    gitSha: 'a'.repeat(40),
    notes: '更新说明',
    compatibility: { minimumVersion: '1.0.0', maximumVersionExclusive: '2.0.0' },
    installer: {
      platform: 'win32-x64',
      format: 'nsis-setup',
      name: 'Mizar-v1.1.0-Windows-x64-Setup.exe',
      bytes: 50,
      sha256: 'b'.repeat(64),
      contentDigest: 'c'.repeat(64),
    },
  };
  const bytes = Buffer.from(JSON.stringify(manifest));
  const digest = createHash('sha256').update(bytes).digest('hex');
  const base = 'https://github.com/Starfie1d1272/Mizar/releases/download/v1.1.0/';
  const release = {
    tag_name: 'v1.1.0',
    draft: false,
    prerelease: false,
    published_at: '2026-10-09',
    assets: [
      {
        name: 'update-manifest.json',
        size: bytes.length,
        digest: `sha256:${digest}`,
        browser_download_url: base + 'update-manifest.json',
      },
      {
        name: manifest.installer.name,
        size: 50,
        digest: `sha256:${'b'.repeat(64)}`,
        browser_download_url: base + manifest.installer.name,
      },
    ],
  };
  const bundle = {
    dsseEnvelope: {
      payloadType: 'application/vnd.in-toto+json',
      payload: Buffer.from(
        JSON.stringify({
          _type: 'https://in-toto.io/Statement/v1',
          subject: [{ name: 'update-manifest.json', digest: { sha256: digest } }],
          predicateType: 'https://slsa.dev/provenance/v1',
          predicate: {
            buildDefinition: {
              resolvedDependencies: [
                {
                  uri: 'git+https://github.com/Starfie1d1272/Mizar@refs/heads/main',
                  digest: { gitCommit: manifest.gitSha },
                },
              ],
              externalParameters: {
                workflow: {
                  repository: 'https://github.com/Starfie1d1272/Mizar',
                  path: '.github/workflows/release-qualification.yml',
                  ref: 'refs/heads/main',
                },
              },
            },
          },
        }),
      ).toString('base64'),
    },
  };
  let tagSha = manifest.gitSha;
  const source = new StableSource('/unused', (input) => {
    const url = fetchUrl(input);
    if (url === base + 'update-manifest.json') return Promise.resolve(new Response(bytes));
    if (url.includes('/attestations/'))
      return Promise.resolve(Response.json({ attestations: [{ bundle }] }));
    if (url.includes('/git/ref/tags/'))
      return Promise.resolve(Response.json({ object: { type: 'commit', sha: tagSha } }));
    throw new Error(`unexpected request: ${url}`);
  });
  const signal = new AbortController().signal;
  expect(await source.authenticate(release, signal)).toEqual(manifest);
  expect(createVerifier).toHaveBeenCalledWith(
    expect.objectContaining({
      certificateIssuer: 'https://token.actions.githubusercontent.com',
      certificateIdentityURI:
        '^https://github\\.com/Starfie1d1272/Mizar/\\.github/workflows/release-qualification\\.yml@refs/heads/main$',
      ctLogThreshold: 1,
      tlogThreshold: 1,
    }),
  );
  expect(verify).toHaveBeenCalledWith(bundle);
  tagSha = 'd'.repeat(40);
  await expect(source.authenticate(release, signal)).rejects.toThrow('update_source_mismatch');
  tagSha = manifest.gitSha;
  release.assets[1]!.digest = `sha256:${'e'.repeat(64)}`;
  await expect(source.authenticate(release, signal)).rejects.toThrow('update_asset_mismatch');
  verify.mockImplementation(() => {
    throw new Error('untrusted signer');
  });
  await expect(source.authenticate(release, signal)).rejects.toThrow('update_provenance_failed');
});

it('authenticates the real v1.1 dual signatures transported in the GitHub envelope', async () => {
  const indexBytes = await readFile(new URL('update-index-v2.json', fixture));
  const index = JSON.parse(indexBytes.toString()) as {
    schemaVersion: string;
    manifestBase64: string;
    publicationBase64: string;
    provenance: Bundle;
    publicationProvenance: Bundle;
  };
  const manifest = updateManifestSchema.parse(
    JSON.parse(Buffer.from(index.manifestBase64, 'base64').toString()),
  );
  const publication = updatePublicationSchema.parse(
    JSON.parse(Buffer.from(index.publicationBase64, 'base64').toString()),
  );
  const root = TrustedRoot.fromJSON(
    JSON.parse(await readFile(new URL('trusted_root.json', fixture), 'utf8')),
  );
  const engine = new Verifier(toTrustMaterial(root), { tlogThreshold: 1, ctlogThreshold: 1 });
  vi.mocked(createVerifier).mockImplementation((options) =>
    Promise.resolve({
      verify(bundle, data) {
        const promotion = options?.certificateIdentityURI?.includes('release-promotion');
        return engine.verify(toSignedEntity(bundleFromJSON(bundle), data), {
          subjectAlternativeName: promotion ? PUBLICATION_WORKFLOW : UPDATE_WORKFLOW,
          extensions: { issuer: 'https://token.actions.githubusercontent.com' },
        });
      },
    }),
  );
  let carrier = Buffer.from(indexBytes);
  const releaseId = publication.releaseId;
  const release = {
    id: releaseId,
    tag_name: `v${manifest.version}`,
    draft: false,
    prerelease: false,
    published_at: publication.publishedAt,
    assets: [
      {
        name: 'update-index.json',
        size: carrier.length,
        digest: `sha256:${createHash('sha256').update(carrier).digest('hex')}`,
        browser_download_url: `https://github.com/Starfie1d1272/Mizar/releases/download/v${manifest.version}/update-index.json`,
      },
      {
        name: manifest.installer.name,
        size: manifest.installer.bytes,
        digest: `sha256:${manifest.installer.sha256}`,
        browser_download_url: `https://github.com/Starfie1d1272/Mizar/releases/download/v${manifest.version}/${manifest.installer.name}`,
      },
    ],
  };
  const fetcher = vi.fn<typeof fetch>((input) => {
    const url = fetchUrl(input);
    if (url.endsWith('/update-index.json') || url.endsWith('/' + MACHINE_METADATA_NAME))
      return Promise.resolve(new Response(carrier));
    if (url.endsWith(`/git/ref/tags/v${manifest.version}`))
      return Promise.resolve(Response.json({ object: { type: 'commit', sha: manifest.gitSha } }));
    throw new Error(`unexpected request: ${url}`);
  });
  const source = new StableSource('/unused', fetcher),
    signal = new AbortController().signal;
  expect(await source.authenticate(release, signal)).toEqual(manifest);
  // Same original production signatures, with GitHub explicitly unreachable.
  const boxFetcher = vi.fn<typeof fetch>((input, init) => {
    const url = new URL(fetchUrl(input));
    if (url.hostname !== 'box.nju.edu.cn') throw new Error('github_unreachable');
    if (url.pathname.endsWith('/dir/'))
      return Promise.resolve(Response.json({ repo_name: 'Mizar', user_perm: 'r' }));
    if (url.pathname.endsWith('/download-link/')) {
      expect(new Headers(init?.headers).get('Authorization')).toMatch(/^Token /);
      return Promise.resolve(
        Response.json('https://box.nju.edu.cn/seafhttp/files/original/latest.json'),
      );
    }
    expect(new Headers(init?.headers).has('Authorization')).toBe(false);
    return Promise.resolve(new Response(carrier));
  });
  const domestic = new StableSource('/unused', boxFetcher);
  const mirrored = await domestic.latest(signal, manifest.version);
  expect(mirrored?.tag_name).toBe(release.tag_name);
  expect(await domestic.authenticate(mirrored!, signal)).toEqual(manifest);
  expect(
    boxFetcher.mock.calls.every(
      ([input]) => new URL(fetchUrl(input)).hostname === 'box.nju.edu.cn',
    ),
  ).toBe(true);
  // The transport preserves the same real SDK proofs; it adds no trust root.
  const originalAsset = { ...release.assets[0]! };
  carrier = makeMachineMetadata(new Map([['update-index.json', indexBytes]]));
  release.assets[0] = {
    name: MACHINE_METADATA_NAME,
    size: carrier.length,
    digest: 'sha256:' + createHash('sha256').update(carrier).digest('hex'),
    browser_download_url: originalAsset.browser_download_url.replace(
      'update-index.json',
      MACHINE_METADATA_NAME,
    ),
  };
  expect(await source.authenticate(release, signal)).toEqual(manifest);
  carrier = Buffer.from(indexBytes);
  release.assets[0] = originalAsset;
  for (const mutate of [
    (value: typeof index) => {
      value.manifestBase64 = Buffer.from('{}').toString('base64');
    },
    (value: typeof index) => {
      value.publicationBase64 = Buffer.from('{}').toString('base64');
    },
    (value: typeof index) => {
      value.publicationProvenance = value.provenance;
    },
    (value: typeof index) => {
      value.provenance = value.publicationProvenance;
    },
  ]) {
    const changed = structuredClone(index);
    mutate(changed);
    carrier = Buffer.from(JSON.stringify(changed));
    release.assets[0]!.size = carrier.length;
    release.assets[0]!.digest = `sha256:${createHash('sha256').update(carrier).digest('hex')}`;
    await expect(source.authenticate(release, signal)).rejects.toThrow();
  }
  carrier = Buffer.from(indexBytes);
  release.assets[0]!.size = carrier.length;
  release.assets[0]!.digest = `sha256:${createHash('sha256').update(carrier).digest('hex')}`;
  release.id = releaseId + 1;
  await expect(source.authenticate(release, signal)).rejects.toThrow('update_publication_mismatch');
  release.id = releaseId;
  release.published_at = '2026-10-10T00:00:00Z';
  await expect(source.authenticate(release, signal)).rejects.toThrow('update_publication_mismatch');
});
