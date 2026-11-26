import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Bundle } from 'sigstore';
import {
  createMizarVerifier,
  verifyMizarAttestation,
} from '@mizar/resource-pack-contract/attestation';
import { boundedBytes, fetchHttps, fetchJson, type FetchLike } from '../distribution/http.js';
import { diagnosticValue } from '../support/diagnostic-value.js';
import { MULNX_REPOSITORY, type MulnxRelease } from './tool-release.js';

// Public distribution credential: the Mizar library contains public releases only,
// and the server grants this dedicated token read permission (r). It is not a signing key.
const BOX_READ_TOKEN = 'b88f62e59ca365d27ccb48f55dfef3a78965341f';

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

function redactBoxError(error: unknown): Error {
  const safe = diagnosticValue(error, '', new Set(), [BOX_READ_TOKEN]) as {
    message?: unknown;
  } | null;
  const message =
    error instanceof Error
      ? typeof safe?.message === 'string'
        ? safe.message
        : 'mulnx_mirror_failed'
      : 'mulnx_mirror_failed';
  return new Error(message, { cause: safe });
}

async function boxLink(
  path: string,
  signal: AbortSignal,
  fetcher: FetchLike = globalThis.fetch,
): Promise<string> {
  if (
    path !== '/Tools/MulNX/latest.json' &&
    !/^\/Tools\/MulNX\/[1-9][0-9]*\/[1-9][0-9]*\/(?:MulNX\.7z|LICENSE\.txt|COPYRIGHT\.md|SECURITY\.md)$/.test(
      path,
    )
  ) {
    throw new Error('mulnx_mirror_path_invalid');
  }
  const url = z
    .string()
    .max(8192)
    .parse(
      await fetchJson(
        `https://box.nju.edu.cn/api/v2.1/via-repo-token/download-link/?path=${encodeURIComponent(path)}`,
        {
          signal,
          fetcher,
          maxBytes: 16 * 1024,
          headers: { Authorization: `Token ${BOX_READ_TOKEN}` },
        },
      ).catch((error: unknown) => {
        throw redactBoxError(error);
      }),
    );
  const parsed = new URL(url);
  if (
    parsed.origin !== 'https://box.nju.edu.cn' ||
    parsed.username ||
    parsed.password ||
    parsed.hash ||
    !parsed.pathname.startsWith('/seafhttp/files/')
  ) {
    throw new Error('mulnx_mirror_link_invalid');
  }
  return url;
}

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
  try {
    const directory = await fetchJson(
      'https://box.nju.edu.cn/api/v2.1/via-repo-token/dir/?path=%2FTools%2FMulNX',
      {
        signal,
        headers: { Authorization: `Token ${BOX_READ_TOKEN}` },
      },
    );
    z.object({ repo_name: z.literal('Mizar'), user_perm: z.literal('r') }).parse(directory);
    const bytes = await boundedBytes(
      await fetchHttps(await boxLink('/Tools/MulNX/latest.json', signal), { signal }),
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
    ) {
      throw new Error('mulnx_mirror_invalid');
    }
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
    ) {
      throw new Error('mulnx_mirror_invalid');
    }
    return index;
  } catch (error) {
    throw redactBoxError(error);
  }
}

export async function mirrorArchive(
  index: MulnxMirror,
  signal: AbortSignal,
  rangeEnd?: number,
): Promise<Response> {
  try {
    return await fetchHttps(await boxLink(filePath(index, 'MulNX.7z'), signal), {
      signal,
      ...(rangeEnd === undefined ? {} : { range: { end: rangeEnd } }),
    });
  } catch (error) {
    throw redactBoxError(error);
  }
}

export async function mirrorNotice(
  index: MulnxMirror,
  name: keyof MulnxMirror['notices'],
): Promise<Buffer> {
  const signal = AbortSignal.timeout(15_000);
  const expected = index.notices[name];
  try {
    const bytes = await boundedBytes(
      await fetchHttps(await boxLink(filePath(index, name), signal), {
        signal,
        allowCompressedText: true,
      }),
      expected.size,
    );
    if (
      bytes.length !== expected.size ||
      createHash('sha256').update(bytes).digest('hex') !== expected.sha256
    ) {
      throw new Error('mulnx_mirror_notice_integrity');
    }
    return bytes;
  } catch (error) {
    throw redactBoxError(error);
  }
}
