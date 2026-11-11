import { createHash } from 'node:crypto';
import type { Bundle, BundleVerifier } from 'sigstore';
import { z } from 'zod';
import { UPDATE_REPOSITORY } from './contract.js';

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
