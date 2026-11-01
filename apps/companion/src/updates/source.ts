import {
  MACHINE_METADATA_NAME,
  MACHINE_METADATA_MAX_BYTES,
  readMachineFile,
} from '@mizar/resource-pack-contract/transport';
import { createHash } from 'node:crypto';
import { selectQualifiedCore } from './core.js';
import { BoxSource } from './box.js';
import type { Bundle, BundleVerifier } from 'sigstore';
import { createTufVerifier } from '@mizar/resource-pack-contract/attestation';
import { z } from 'zod';
import { boundedBytes, updateRequest, type UpdateFetch } from './network.js';
import {
  compareVersions,
  UPDATE_REPOSITORY,
  UPDATE_WORKFLOW,
  PUBLICATION_WORKFLOW,
  updatePublicationSchema,
  updateManifestSchema,
  type UpdateManifest,
} from './contract.js';

type Release = {
  tag_name: string;
  draft: false;
  prerelease: false;
  published_at: string;
  assets: never[];
};
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
          path: z.enum([
            '.github/workflows/release-qualification.yml',
            '.github/workflows/release-promotion.yml',
          ]),
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
  workflow: 'qualification' | 'promotion' = 'qualification',
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
  if (
    statement.predicate.buildDefinition.externalParameters.workflow.path !==
    `.github/workflows/release-${workflow}.yml`
  )
    throw new Error('update_provenance_invalid');
  const sha = createHash('sha256').update(bytes).digest('hex');
  const subjects = statement.subject.filter((subject) => subject.name === name);
  if (subjects.length !== 1 || subjects[0]!.digest.sha256 !== sha)
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
    private readonly diagnostic?: (stage: string, error: unknown, durationMs?: number) => void,
  ) {}
  private async verifier(identity: string, signal: AbortSignal): Promise<BundleVerifier> {
    return this.phase('trust_metadata', signal, 20_000, async (deadline) => {
      // SDK verifies cached roles and target hashes; expired/corrupt metadata
      // triggers its normal root rotation and refresh. Never use a custom root.
      const pending = createTufVerifier(
        {
          certificateIssuer: 'https://token.actions.githubusercontent.com',
          certificateIdentityURI: '^' + identity.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$',
          ctLogThreshold: 1,
          tlogThreshold: 1,
          tufCachePath: this.cachePath,
          tufForceCache: true,
          retry: { retries: 1, minTimeout: 250, maxTimeout: 250 },
          timeout: 8000,
        },
        deadline,
      );
      let aborted: (() => void) | undefined;
      try {
        deadline.throwIfAborted();
        return await Promise.race([
          pending,
          new Promise<never>((_resolve, reject) => {
            aborted = () => {
              const reason: unknown = deadline.reason;
              reject(
                reason instanceof Error
                  ? reason
                  : new Error('update_trust_metadata_failed', { cause: reason }),
              );
            };
            deadline.addEventListener('abort', aborted, { once: true });
          }),
        ]);
      } catch (cause) {
        throw new Error('update_trust_metadata_failed', { cause });
      } finally {
        if (aborted) deadline.removeEventListener('abort', aborted);
      }
    });
  }
  private async phase<T>(
    stage: string,
    signal: AbortSignal,
    timeoutMs: number,
    operation: (deadline: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const began = Date.now();
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
    try {
      deadline.throwIfAborted();
      const result = await operation(deadline);
      deadline.throwIfAborted();
      this.diagnostic?.(stage, undefined, Date.now() - began);
      return result;
    } catch (error) {
      this.diagnostic?.(stage, error, Date.now() - began);
      throw error;
    }
  }
  private async verify(
    bytes: Buffer,
    bundles: Bundle[],
    signal: AbortSignal,
  ): Promise<UpdateManifest> {
    const verifier = await this.verifier(UPDATE_WORKFLOW, signal);
    signal.throwIfAborted();
    let verifiedCommit: string | undefined;
    const failures: unknown[] = [];
    for (const bundle of bundles) {
      try {
        verifiedCommit = verifyAttestation(bytes, 'update-manifest.json', bundle, verifier);
        break;
      } catch (error) {
        failures.push(error);
        this.diagnostic?.('qualification_proof_rejected', error);
        /* No alternative signer or trust root is accepted. */
      }
    }
    if (!verifiedCommit) throw new AggregateError(failures, 'update_provenance_failed');
    const manifest = updateManifestSchema.parse(JSON.parse(bytes.toString('utf8')));
    if (manifest.gitSha !== verifiedCommit) throw new Error('update_source_mismatch');
    return manifest;
  }
  private async selectCore(manifest: UpdateManifest, signal: AbortSignal, carrier?: Buffer) {
    if (compareVersions(manifest.version, '1.2.0') < 0) return manifest;
    if (!carrier) {
      try {
        carrier = await this.phase('box_core_metadata', signal, 15_000, (deadline) =>
          new BoxSource(this.fetcher).machine(manifest.version, deadline),
        );
      } catch (error) {
        this.diagnostic?.('box_core_fallback', error);
        signal.throwIfAborted();
      }
      carrier ??= await boundedBytes(
        await updateRequest(
          `https://github.com/${UPDATE_REPOSITORY}/releases/download/v${manifest.version}/${MACHINE_METADATA_NAME}`,
          signal,
          this.fetcher,
        ),
        MACHINE_METADATA_MAX_BYTES,
      );
    }
    const verifier = await this.verifier(UPDATE_WORKFLOW, signal);
    signal.throwIfAborted();
    return selectQualifiedCore(carrier, manifest, verifier);
  }
  private async verifyPublication(
    bytes: Buffer,
    bundle: Bundle,
    manifestBytes: Buffer,
    manifest: UpdateManifest,
    signal: AbortSignal,
  ) {
    const verifier = await this.verifier(PUBLICATION_WORKFLOW, signal);
    signal.throwIfAborted();
    const promotionSha = verifyAttestation(
      bytes,
      'update-publication.json',
      bundle,
      verifier,
      'promotion',
    );
    const publication = updatePublicationSchema.parse(JSON.parse(bytes.toString('utf8')));
    if (
      publication.promotionSha !== promotionSha ||
      publication.version !== manifest.version ||
      publication.gitSha !== manifest.gitSha ||
      publication.manifestSha256 !== createHash('sha256').update(manifestBytes).digest('hex')
    )
      throw new Error('update_publication_mismatch');
    return publication;
  }
  private async authenticateIndex(indexBytes: Buffer, signal: AbortSignal) {
    const index = z
      .strictObject({
        schemaVersion: z.literal('mizar.update-index.v2'),
        manifestBase64: z
          .string()
          .max(90_000)
          .regex(/^[A-Za-z0-9+/]+={0,2}$/),
        provenance: z.unknown(),
        publicationBase64: z
          .string()
          .max(90_000)
          .regex(/^[A-Za-z0-9+/]+={0,2}$/),
        publicationProvenance: z.unknown(),
      })
      .parse(JSON.parse(indexBytes.toString('utf8')));
    const bytes = Buffer.from(index.manifestBase64, 'base64');
    if (bytes.length > 64 * 1024 || bytes.toString('base64') !== index.manifestBase64)
      throw new Error('update_metadata_corrupt');
    const manifest = await this.verify(bytes, [index.provenance as Bundle], signal);
    const publicationBytes = Buffer.from(index.publicationBase64, 'base64');
    if (
      publicationBytes.length > 64 * 1024 ||
      publicationBytes.toString('base64') !== index.publicationBase64
    )
      throw new Error('update_metadata_corrupt');
    const publication = await this.verifyPublication(
      publicationBytes,
      index.publicationProvenance as Bundle,
      bytes,
      manifest,
      signal,
    );
    return { manifest, publication };
  }
  async latest(signal: AbortSignal, minimumVersion?: string): Promise<Release | null> {
    this.mirrorCandidate = undefined;
    const { manifest, publication } = await this.authenticateIndex(
      await this.phase('box_metadata', signal, 15_000, (deadline) =>
        new BoxSource(this.fetcher).metadata(deadline),
      ),
      signal,
    );
    if (minimumVersion && compareVersions(manifest.version, minimumVersion) < 0)
      throw new Error('update_mirror_unavailable');
    const release: Release = {
      tag_name: 'v' + manifest.version,
      draft: false,
      prerelease: false,
      published_at: publication.publishedAt,
      assets: [],
    };
    this.mirrorCandidate = { release, manifest: await this.selectCore(manifest, signal) };
    return release;
  }
  async authenticate(release: Release, signal: AbortSignal): Promise<UpdateManifest> {
    signal.throwIfAborted();
    if (release !== this.mirrorCandidate?.release) throw new Error('update_metadata_missing');
    return this.mirrorCandidate.manifest;
  }
  /** Fixed-version installers authenticate that version's original dual-signed index. */
  async authenticateVersion(version: string, signal: AbortSignal): Promise<UpdateManifest> {
    if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version))
      throw new Error('update_version_invalid');
    const carrier = await this.phase('box_core_metadata', signal, 15_000, (deadline) =>
      new BoxSource(this.fetcher).machine(version, deadline),
    );
    const { manifest } = await this.authenticateIndex(
      readMachineFile(carrier, 'update-index.json'),
      signal,
    );
    if (manifest.version !== version) throw new Error('update_tag_mismatch');
    return this.selectCore(manifest, signal, carrier);
  }
}
export function installerUrl(manifest: UpdateManifest): string {
  return `https://github.com/${UPDATE_REPOSITORY}/releases/download/v${manifest.version}/${manifest.installer.name}`;
}
