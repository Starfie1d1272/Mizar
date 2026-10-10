import { readMachineFile } from '@mizar/resource-pack-contract/transport';
import { z } from 'zod';
import type { Bundle, BundleVerifier } from 'sigstore';
import { UPDATE_MAX_BYTES, type UpdateManifest } from './contract.js';
import { verifyAttestation } from './source.js';

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const releaseSchema = z.object({
  schemaVersion: z.literal(1),
  appVersion: z.string(),
  gitSha: z.string().regex(/^[a-f0-9]{40}$/),
  archive: z.string(),
  archiveSha256: sha256,
  contentDigest: sha256,
  desktopBuildProfile: z.literal('release'),
  developmentOnly: z.literal(false),
  resourceMode: z.enum(['full', 'core']),
  derivedFrom: z
    .object({ archive: z.string(), archiveSha256: sha256, contentDigest: sha256 })
    .optional(),
});
const distributionSchema = z.object({
  schemaVersion: z.literal(1),
  appVersion: z.string(),
  gitSha: z.string().regex(/^[a-f0-9]{40}$/),
  archive: z.string(),
  archiveSha256: sha256,
  archiveBytes: z.number().int().positive().max(UPDATE_MAX_BYTES),
  contentDigest: sha256,
  originalArchiveSha256: sha256,
  format: z.literal('nsis-setup'),
});

/** All four original messages must be subjects of the same verified Qualification envelope. */
export function selectQualifiedCore(
  carrier: Buffer,
  full: UpdateManifest,
  verifier: BundleVerifier,
): UpdateManifest {
  const bundle = JSON.parse(
    readMachineFile(carrier, 'qualification-provenance.json').toString('utf8'),
  ) as Bundle;
  const messages = Object.fromEntries(
    [
      'release-manifest.json',
      'distribution-manifest.json',
      'core-release-manifest.json',
      'core-distribution-manifest.json',
    ].map((name) => {
      const bytes = readMachineFile(carrier, name);
      if (verifyAttestation(bytes, name, bundle, verifier) !== full.gitSha)
        throw new Error('update_core_source_mismatch');
      return [name, JSON.parse(bytes.toString('utf8'))];
    }),
  );
  const original = releaseSchema.parse(messages['release-manifest.json']);
  const originalSetup = distributionSchema.parse(messages['distribution-manifest.json']);
  const core = releaseSchema.parse(messages['core-release-manifest.json']);
  const setup = distributionSchema.parse(messages['core-distribution-manifest.json']);
  const name = `Mizar-v${full.version}-Windows-x64`;
  if (
    [original, originalSetup, core, setup].some(
      (message) => message.gitSha !== full.gitSha || message.appVersion !== full.version,
    ) ||
    original.resourceMode !== 'full' ||
    original.archive !== name + '.zip' ||
    originalSetup.archive !== full.installer.name ||
    originalSetup.archive !== name + '-Setup.exe' ||
    originalSetup.archiveSha256 !== full.installer.sha256 ||
    originalSetup.archiveBytes !== full.installer.bytes ||
    originalSetup.contentDigest !== full.installer.contentDigest ||
    originalSetup.contentDigest !== original.contentDigest ||
    originalSetup.originalArchiveSha256 !== original.archiveSha256 ||
    core.resourceMode !== 'core' ||
    core.archive !== name + '-Core.zip' ||
    core.derivedFrom?.archive !== original.archive ||
    core.derivedFrom.archiveSha256 !== original.archiveSha256 ||
    core.derivedFrom.contentDigest !== original.contentDigest ||
    setup.archive !== name + '-Core-Setup.exe' ||
    setup.originalArchiveSha256 !== core.archiveSha256 ||
    setup.contentDigest !== core.contentDigest
  )
    throw new Error('update_core_identity_mismatch');
  return {
    ...full,
    coreArchiveSha256: core.archiveSha256,
    installer: {
      platform: 'win32-x64',
      format: setup.format,
      name: setup.archive,
      bytes: setup.archiveBytes,
      sha256: setup.archiveSha256,
      contentDigest: setup.contentDigest,
    },
  };
}
