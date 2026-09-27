import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { FastifyInstance } from 'fastify';
import { checkLocalWebOrigin, type LocalWebOriginPolicy } from '../local-web/origin-policy.js';

const MAX_ASSET_BYTES = 512_000;
const MIME_EXTENSION = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
} as const;

function validImage(bytes: Buffer, mime: keyof typeof MIME_EXTENSION): boolean {
  if (mime === 'image/png')
    return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (mime === 'image/jpeg')
    return (
      bytes.length >= 4 &&
      bytes[0] === 0xff &&
      bytes[1] === 0xd8 &&
      bytes.at(-2) === 0xff &&
      bytes.at(-1) === 0xd9
    );
  return (
    bytes.length >= 12 &&
    bytes.toString('ascii', 0, 4) === 'RIFF' &&
    bytes.toString('ascii', 8, 12) === 'WEBP'
  );
}

export function registerLocalAssetRoutes(
  app: FastifyInstance,
  options: {
    readonly directory: string;
    readonly originPolicy: LocalWebOriginPolicy;
  },
): void {
  app.post('/operator/local-asset', { bodyLimit: 800_000 }, async (request, reply) => {
    if (
      options.originPolicy.mode !== 'loopback' ||
      !checkLocalWebOrigin(options.originPolicy, request.headers.origin).allowed
    )
      return reply.code(403).send({ error: 'operator_origin_forbidden' });
    const body = request.body as Record<string, unknown> | null;
    if (
      !body ||
      typeof body.mimeType !== 'string' ||
      !(body.mimeType in MIME_EXTENSION) ||
      typeof body.base64 !== 'string' ||
      body.base64.length > 700_000 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(body.base64)
    )
      return reply.code(400).send({ error: 'local_asset_invalid' });
    const mime = body.mimeType as keyof typeof MIME_EXTENSION;
    const bytes = Buffer.from(body.base64, 'base64');
    if (
      bytes.length === 0 ||
      bytes.length > MAX_ASSET_BYTES ||
      bytes.toString('base64') !== body.base64 ||
      !validImage(bytes, mime)
    )
      return reply.code(400).send({ error: 'local_asset_invalid' });
    const digest = createHash('sha256').update(bytes).digest('hex');
    const filename = `${digest}.${MIME_EXTENSION[mime]}`;
    try {
      await mkdir(options.directory, { recursive: true });
      await writeFile(join(options.directory, filename), bytes, { mode: 0o600, flag: 'wx' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST')
        return reply.code(500).send({ error: 'local_asset_write_failed' });
    }
    return { url: `/local/v1/local-assets/${filename}` };
  });

  app.get('/local/v1/local-assets/:filename', async (request, reply) => {
    const filename = (request.params as { filename: string }).filename;
    if (!/^[a-f0-9]{64}\.(?:png|jpg|webp)$/.test(filename))
      return reply.code(404).send({ error: 'local_asset_not_found' });
    try {
      const bytes = await readFile(join(options.directory, filename));
      const mime = filename.endsWith('.png')
        ? 'image/png'
        : filename.endsWith('.jpg')
          ? 'image/jpeg'
          : 'image/webp';
      return reply
        .header('content-type', mime)
        .header('cache-control', 'public, max-age=31536000, immutable')
        .header('x-content-type-options', 'nosniff')
        .send(bytes);
    } catch {
      return reply.code(404).send({ error: 'local_asset_not_found' });
    }
  });
}
