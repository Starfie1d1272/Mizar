import { createHash } from 'node:crypto';
import { BoxSource } from './box.js';
import { createVerifier, type Bundle, type BundleVerifier } from 'sigstore';
import { z } from 'zod';
import { boundedBytes, updateJson, updateRequest, type UpdateFetch } from './network.js';
import {
  compareVersions,
  UPDATE_REPOSITORY,
  UPDATE_WORKFLOW,
  updateManifestSchema,
  type UpdateManifest,
} from './contract.js';

const api = `https://api.github.com/repos/${UPDATE_REPOSITORY}`;
const assetSchema = z.object({
  name: z.string(),
  size: z.number().int().positive(),
  digest: z.string().nullable(),
  browser_download_url: z.string(),
});
const releaseSchema = z.object({
  tag_name: z.string(),
  draft: z.boolean(),
  prerelease: z.boolean(),
  published_at: z.string().nullable(),
  assets: z.array(assetSchema).max(100),
});
type Release = z.infer<typeof releaseSchema>;
const attestationSchema = z.object({
  _type: z.literal('https://in-toto.io/Statement/v1'),
  subject: z.array(z.object({ name: z.string(), digest: z.object({ sha256: z.string() }) })),
  predicateType: z.literal('https://slsa.dev/provenance/v1'),
  predicate: z.object({
    buildDefinition: z.object({
      resolvedDependencies: z.array(
        z.object({
          uri: z.string(),
          digest: z.object({ gitCommit: z.string().regex(/^[a-f0-9]{40}$/) }),
        }),
      ),
      externalParameters: z.object({
        workflow: z.object({
          repository: z.literal(`https://github.com/${UPDATE_REPOSITORY}`),
          path: z.literal('.github/workflows/release-qualification.yml'),
          ref: z.literal('refs/heads/main'),
        }),
      }),
    }),
  }),
});

export function verifyAttestation(
  bytes: Buffer,
  name: string,
  bundle: Bundle,
  verifier: BundleVerifier,
): string {
  // Verify the envelope before interpreting any of its claims. The configured
  // certificate policy is mandatory and is never taken from the envelope.
  verifier.verify(bundle);
  const envelope = (bundle as { dsseEnvelope?: { payloadType?: string; payload?: string } })
    .dsseEnvelope;
  if (
    envelope?.payloadType !== 'application/vnd.in-toto+json' ||
    typeof envelope.payload !== 'string'
  )
    throw new Error('update_provenance_invalid');
  const statement = attestationSchema.parse(
    JSON.parse(Buffer.from(envelope.payload, 'base64').toString('utf8')),
  );
  const sha = createHash('sha256').update(bytes).digest('hex');
  if (!statement.subject.some((s) => s.name === name && s.digest.sha256 === sha))
    throw new Error('update_subject_mismatch');
  const source = statement.predicate.buildDefinition.resolvedDependencies.filter(
    (d) => d.uri === `git+https://github.com/${UPDATE_REPOSITORY}@refs/heads/main`,
  );
  if (source.length !== 1) throw new Error('update_source_mismatch');
  return source[0]!.digest.gitCommit;
}

export class StableSource {
  private mirrorCandidate: { release: Release; manifest: UpdateManifest } | undefined;
  constructor(
    private readonly cachePath: string,
    private readonly fetcher: UpdateFetch = globalThis.fetch,
  ) {}
  private async verify(
    bytes: Buffer,
    bundles: Bundle[],
    signal: AbortSignal,
  ): Promise<UpdateManifest> {
    const verifier = await createVerifier({
      certificateIssuer: 'https://token.actions.githubusercontent.com',
      certificateIdentityURI: UPDATE_WORKFLOW,
      ctLogThreshold: 1,
      tlogThreshold: 1,
      tufCachePath: this.cachePath,
      retry: 0,
      timeout: 5000,
    });
    signal.throwIfAborted();
    let verifiedCommit: string | undefined;
    for (const bundle of bundles) {
      try {
        verifiedCommit = verifyAttestation(bytes, 'update-manifest.json', bundle, verifier);
        break;
      } catch {
        /* No alternative signer or trust root is accepted. */
      }
    }
    if (!verifiedCommit) throw new Error('update_provenance_failed');
    const manifest = updateManifestSchema.parse(JSON.parse(bytes.toString('utf8')));
    if (manifest.gitSha !== verifiedCommit) throw new Error('update_source_mismatch');
    return manifest;
  }
  async latest(signal: AbortSignal, minimumVersion?: string): Promise<Release | null> {
    this.mirrorCandidate = undefined;
    try {
      const attempt = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
      const box = new BoxSource(this.fetcher);
      const index = z
        .strictObject({
          schemaVersion: z.literal('mizar.update-index.v1'),
          manifestBase64: z
            .string()
            .max(90_000)
            .regex(/^[A-Za-z0-9+/]+={0,2}$/),
          provenance: z.unknown(),
        })
        .parse(JSON.parse((await box.metadata(attempt)).toString('utf8')));
      const bytes = Buffer.from(index.manifestBase64, 'base64');
      if (bytes.length > 64 * 1024 || bytes.toString('base64') !== index.manifestBase64)
        throw new Error('update_metadata_corrupt');
      const manifest = await this.verify(bytes, [index.provenance as Bundle], attempt);
      if (minimumVersion && compareVersions(manifest.version, minimumVersion) < 0)
        throw new Error('update_mirror_unavailable');
      const release = {
        tag_name: `v${manifest.version}`,
        draft: false,
        prerelease: false,
        published_at: 'signed',
        assets: [],
      };
      this.mirrorCandidate = { release, manifest };
      return release;
    } catch {
      signal.throwIfAborted();
    }
    // 'latest' alone can select a release by publication date rather than SemVer.
    const values: Release[] = [];
    for (let page = 1; ; page++) {
      const batch = z
        .array(releaseSchema)
        .max(100)
        .parse(
          await updateJson(
            `${api}/releases?per_page=100&page=${page}`,
            signal,
            this.fetcher,
            2 * 1024 * 1024,
          ),
        );
      values.push(...batch);
      if (batch.length < 100) break;
      if (page === 10) throw new Error('update_release_list_too_large');
    }
    const releases = values.filter(
      (r) =>
        !r.draft &&
        !r.prerelease &&
        r.published_at &&
        /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(r.tag_name),
    );
    releases.sort((a, b) => compareVersions(b.tag_name.slice(1), a.tag_name.slice(1)));
    return releases[0] ?? null;
  }
  async authenticate(release: Release, signal: AbortSignal): Promise<UpdateManifest> {
    if (release === this.mirrorCandidate?.release) {
      signal.throwIfAborted();
      return this.mirrorCandidate.manifest;
    }
    const metas = release.assets.filter((a) => a.name === 'update-manifest.json');
    if (metas.length !== 1 || metas[0]!.size > 64 * 1024)
      throw new Error('update_metadata_missing');
    const meta = metas[0]!;
    const url = `https://github.com/${UPDATE_REPOSITORY}/releases/download/${release.tag_name}/update-manifest.json`;
    if (meta.browser_download_url !== url) throw new Error('update_asset_invalid');
    const bytes = await boundedBytes(await updateRequest(url, signal, this.fetcher), 64 * 1024);
    const sha = createHash('sha256').update(bytes).digest('hex');
    if (meta.size !== bytes.length || meta.digest !== `sha256:${sha}`)
      throw new Error('update_metadata_corrupt');
    const bundles = z
      .object({
        attestations: z
          .array(z.object({ bundle: z.unknown() }))
          .min(1)
          .max(20),
      })
      .parse(
        await updateJson(
          `${api}/attestations/sha256:${sha}?per_page=20`,
          signal,
          this.fetcher,
          2 * 1024 * 1024,
        ),
      );
    const manifest = await this.verify(
      bytes,
      bundles.attestations.map((e) => e.bundle as Bundle),
      signal,
    );
    if (`v${manifest.version}` !== release.tag_name) throw new Error('update_tag_mismatch');
    const tag = z
      .object({ object: z.object({ type: z.literal('commit'), sha: z.string() }) })
      .parse(await updateJson(`${api}/git/ref/tags/${release.tag_name}`, signal, this.fetcher));
    if (tag.object.sha !== manifest.gitSha) throw new Error('update_source_mismatch');
    const assets = release.assets.filter((a) => a.name === manifest.installer.name);
    if (
      assets.length !== 1 ||
      assets[0]!.size !== manifest.installer.bytes ||
      assets[0]!.digest !== `sha256:${manifest.installer.sha256}` ||
      assets[0]!.browser_download_url !== installerUrl(manifest)
    )
      throw new Error('update_asset_mismatch');
    return manifest;
  }
}
export function installerUrl(manifest: UpdateManifest): string {
  return `https://github.com/${UPDATE_REPOSITORY}/releases/download/v${manifest.version}/${manifest.installer.name}`;
}
