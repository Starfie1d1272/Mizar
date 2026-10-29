import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Bundle } from 'sigstore';
import {
  createMizarVerifier,
  verifyMizarAttestation,
} from '@mizar/resource-pack-contract/attestation';
import { BoxSource } from '../updates/box.js';
import { boundedBytes, updateJson, updateRequest } from '../updates/network.js';
import { MULNX_REPOSITORY, type MulnxRelease } from './tool-release.js';

const sha = z.string().regex(/^[a-f0-9]{64}$/);
const notice = z
  .object({
    size: z
      .number()
      .int()
      .positive()
      .max(256 * 1024),
    sha256: sha,
  })
  .strict();
const indexSchema = z
  .object({
    schema: z.literal('mizar.mulnx-index.v1'),
    repository: z.literal(MULNX_REPOSITORY),
    sourceSha: z.string().regex(/^[a-f0-9]{40}$/),
    checkedAt: z.iso.datetime(),
    release: z
      .object({
        id: z.number().int().positive().safe(),
        assetId: z.number().int().positive().safe(),
        tag: z.string().regex(/^[\w.+-]{1,100}$/),
        publishedAt: z.iso.datetime(),
        url: z.string(),
        size: z
          .number()
          .int()
          .positive()
          .max(64 * 1024 * 1024),
        sha256: sha,
      })
      .strict(),
    notices: z
      .object({ 'LICENSE.txt': notice, 'COPYRIGHT.md': notice, 'SECURITY.md': notice })
      .strict(),
  })
  .strict();
export type MulnxMirror = z.infer<typeof indexSchema>;
const filePath = (index: MulnxMirror, name: string) =>
  `/Tools/MulNX/${index.release.id}/${index.release.assetId}/${name}`;
export function sameMulnxAsset(a: MulnxRelease, b: MulnxRelease) {
  return (
    a.id === b.id &&
    a.assetId === b.assetId &&
    a.sha256 === b.sha256 &&
    a.size === b.size &&
    a.tag === b.tag &&
    a.publishedAt === b.publishedAt &&
    a.url === b.url
  );
}
export async function readMulnxMirror(cachePath: string): Promise<MulnxMirror> {
  const signal = AbortSignal.timeout(15_000);
  const directory = await updateJson(
    'https://box.nju.edu.cn/api/v2.1/via-repo-token/dir/?path=%2FTools%2FMulNX',
    signal,
  );
  z.object({ repo_name: z.literal('Mizar'), user_perm: z.literal('r') }).parse(directory);
  const box = new BoxSource();
  const bytes = await boundedBytes(
    await updateRequest(await box.link('/Tools/MulNX/latest.json', signal), signal),
    2 * 1024 * 1024,
  );
  const envelope = z
    .object({
      schema: z.literal('mizar.mulnx-envelope.v1'),
      indexBase64: z.string().max(128 * 1024),
      proof: z.unknown(),
    })
    .strict()
    .parse(JSON.parse(bytes.toString('utf8')));
  const indexBytes = Buffer.from(envelope.indexBase64, 'base64');
  if (indexBytes.length > 64 * 1024 || indexBytes.toString('base64') !== envelope.indexBase64)
    throw new Error('mulnx_mirror_invalid');
  const index = indexSchema.parse(JSON.parse(indexBytes.toString('utf8')));
  if (
    index.release.url !==
      `https://github.com/${MULNX_REPOSITORY}/releases/download/${index.release.tag}/MulNX.7z` ||
    Date.parse(index.checkedAt) > Date.now() + 5 * 60_000
  )
    throw new Error('mulnx_mirror_invalid');
  const timeout = AbortSignal.timeout(20_000);
  const verifier = await Promise.race([
    createMizarVerifier('mulnx-sync', index.sourceSha, cachePath),
    new Promise<never>((_, reject) =>
      timeout.addEventListener('abort', () => reject(timeout.reason), { once: true }),
    ),
  ]);
  if (
    verifyMizarAttestation(
      indexBytes,
      'mulnx-index.json',
      envelope.proof as Bundle,
      verifier,
      'mulnx-sync',
    ) !== index.sourceSha
  )
    throw new Error('mulnx_mirror_invalid');
  return index;
}
export async function mirrorArchive(index: MulnxMirror, signal: AbortSignal): Promise<Response> {
  const box = new BoxSource();
  return updateRequest(await box.link(filePath(index, 'MulNX.7z'), signal), signal);
}
export async function mirrorNotice(
  index: MulnxMirror,
  name: keyof MulnxMirror['notices'],
): Promise<Buffer> {
  const signal = AbortSignal.timeout(15_000);
  const box = new BoxSource();
  const expected = index.notices[name];
  const bytes = await boundedBytes(
    await updateRequest(await box.link(filePath(index, name), signal), signal),
    expected.size,
  );
  if (
    bytes.length !== expected.size ||
    createHash('sha256').update(bytes).digest('hex') !== expected.sha256
  )
    throw new Error('mulnx_mirror_notice_integrity');
  return bytes;
}
