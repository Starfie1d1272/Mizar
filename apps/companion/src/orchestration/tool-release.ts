import { z } from 'zod';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, mkdir, open, readdir, readFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';

export const MULNX_REPOSITORY = 'Co1Swet/MulNX_CS2';
export const SEVEN_ZIP = {
  version: '26.04',
  url: 'https://github.com/ip7z/7zip/releases/download/26.04/7zr.exe',
  sha256: '256feca8e274e5da655e2a284fabafd9f554365eb164862089dacd4e8276d282',
};
export interface MulnxRelease {
  id: number;
  assetId: number;
  tag: string;
  publishedAt: string;
  url: string;
  size: number;
  sha256: string;
}
const execute = promisify(execFile);
const MAX_ARCHIVE = 64 * 1024 * 1024;
const MAX_EXPANDED = 512 * 1024 * 1024;

const metadataCache = new Map<string, { value: unknown; until: number }>();
const metadataPending = new Map<string, Promise<unknown>>();
let metadataRetry: { until: number; status: number } | undefined;

export function publicJson(url: string): Promise<unknown> {
  const cached = metadataCache.get(url);
  if (cached && cached.until > Date.now()) return Promise.resolve(cached.value);
  if (metadataRetry && metadataRetry.until > Date.now())
    return Promise.reject(new Error(`mulnx_metadata_http_${metadataRetry.status}`));
  const pending = metadataPending.get(url);
  if (pending) return pending;
  const task = fetchPublicJson(url).finally(() => metadataPending.delete(url));
  metadataPending.set(url, task);
  return task;
}

async function fetchPublicJson(url: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'Mizar-MulNX' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    if (
      response.status === 429 ||
      (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0')
    ) {
      const now = Date.now();
      const retry = response.headers.get('retry-after');
      const seconds = retry && /^\d+$/.test(retry) ? Number(retry) * 1000 : 0;
      const retryDate = retry ? Date.parse(retry) : NaN;
      const reset = Number(response.headers.get('x-ratelimit-reset')) * 1000;
      metadataRetry = {
        status: response.status,
        until: Math.max(
          now + 60_000,
          now + seconds,
          Number.isFinite(retryDate) ? retryDate : 0,
          Number.isFinite(reset) ? reset : 0,
        ),
      };
    }
    throw new Error(`mulnx_metadata_http_${response.status}`);
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (!response.body) throw new Error('mulnx_metadata_empty');
  for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
    size += chunk.length;
    if (size > 2 * 1024 * 1024) throw new Error('mulnx_metadata_too_large');
    chunks.push(chunk);
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  metadataCache.set(url, { value, until: Date.now() + 5 * 60_000 });
  return value;
}

/** Latest published upstream build, including public beta releases; no Mizar-version pin. */
export async function latestMulnxRelease(readMetadata = publicJson): Promise<MulnxRelease> {
  const data = await readMetadata(
    `https://api.github.com/repos/${MULNX_REPOSITORY}/releases?per_page=20`,
  );
  const releases = z
    .array(
      z.object({
        id: z.number().int().positive(),
        draft: z.boolean(),
        published_at: z.string().nullable(),
        tag_name: z.string(),
        assets: z.array(
          z.object({
            id: z.number().int().positive(),
            name: z.string(),
            digest: z.string().nullable().optional(),
            size: z.number().int(),
            browser_download_url: z.string(),
          }),
        ),
      }),
    )
    .parse(data)
    .filter((r) => !r.draft && r.published_at && Number.isFinite(Date.parse(r.published_at)))
    .sort((a, b) => Date.parse(b.published_at!) - Date.parse(a.published_at!));
  const release = releases[0];
  const asset = release?.assets.find((a) => a.name === 'MulNX.7z');
  const sha256 = asset?.digest?.replace(/^sha256:/, '') ?? '';
  if (
    !release ||
    !asset ||
    !release.published_at ||
    !/^[\w.+-]{1,100}$/.test(release.tag_name) ||
    asset.size < 1 ||
    asset.size > MAX_ARCHIVE ||
    !/^[a-f0-9]{64}$/.test(sha256) ||
    asset.browser_download_url !==
      `https://github.com/${MULNX_REPOSITORY}/releases/download/${release.tag_name}/MulNX.7z`
  )
    throw new Error('mulnx_latest_release_incomplete');
  return {
    id: release.id,
    assetId: asset.id,
    tag: release.tag_name,
    publishedAt: release.published_at,
    url: asset.browser_download_url,
    size: asset.size,
    sha256,
  };
}

export async function downloadVerified(
  url: string,
  target: string,
  sha256: string,
  expectedSize?: number,
) {
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok || !response.body) throw new Error(`mulnx_download_http_${response.status}`);
  const file = await open(target, 'wx', 0o600);
  const digest = createHash('sha256');
  let size = 0;
  try {
    for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
      size += chunk.length;
      if (size > (expectedSize ?? MAX_ARCHIVE)) throw new Error('mulnx_download_too_large');
      digest.update(chunk);
      let written = 0;
      while (written < chunk.length) {
        const result = await file.write(chunk.subarray(written));
        if (!result.bytesWritten) throw new Error('mulnx_download_write_failed');
        written += result.bytesWritten;
      }
    }
    if ((expectedSize !== undefined && size !== expectedSize) || digest.digest('hex') !== sha256)
      throw new Error('mulnx_download_integrity');
    await file.sync();
  } finally {
    await file.close();
  }
}

export async function fileSha256(path: string): Promise<string> {
  const file = await open(path, 'r');
  const digest = createHash('sha256');
  try {
    for await (const chunk of file.createReadStream({ autoClose: false }) as AsyncIterable<Buffer>)
      digest.update(chunk);
  } finally {
    await file.close();
  }
  return digest.digest('hex');
}

function safeArchivePath(path: string) {
  const normalized = path.replaceAll('\\', '/');
  const parts = normalized.split('/');
  return (
    normalized === 'MulNX' ||
    (parts[0] === 'MulNX' &&
      parts.every(
        (p) =>
          p.length > 0 &&
          p !== '.' &&
          p !== '..' &&
          !/[<>:"|?*]/.test(p) &&
          [...p].every((c) => c.charCodeAt(0) >= 32) &&
          !/[. ]$/.test(p) &&
          !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p),
      ))
  );
}

/** Use the bundled, checksum-verified extractor; reject paths/links before extracting. */
export async function extractMulnx(extractor: string, archive: string, destination: string) {
  const { stdout } = await execute(extractor, ['l', '-slt', '-sccUTF-8', archive], {
    windowsHide: true,
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
    encoding: 'utf8',
  });
  const listing = stdout.split('----------')[1];
  if (!listing) throw new Error('mulnx_archive_listing_invalid');
  const entries = listing.trim().split(/\r?\n\s*\r?\n/);
  const names = new Set<string>();
  let total = 0;
  if (entries.length > 8192) throw new Error('mulnx_archive_entry_budget');
  for (const entry of entries) {
    const path = /^Path = (.+)$/m.exec(entry.replaceAll('\r', ''))?.[1];
    const size = Number(/^Size = (\d+)$/m.exec(entry.replaceAll('\r', ''))?.[1] ?? 0);
    const canonical = path?.replaceAll('\\', '/').toLowerCase();
    if (
      !path ||
      !canonical ||
      !safeArchivePath(path) ||
      names.has(canonical) ||
      /^(Symbolic Link|Hard Link) = .+/m.test(entry) ||
      !Number.isSafeInteger(size) ||
      (total += size) > MAX_EXPANDED
    )
      throw new Error('mulnx_archive_unsafe');
    names.add(canonical);
  }
  await mkdir(destination, { recursive: false });
  await execute(extractor, ['x', '-y', '-sccUTF-8', `-o${destination}`, archive], {
    windowsHide: true,
    timeout: 60_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  let count = 0,
    bytes = 0;
  const visit = async (directory: string) => {
    for (const entry of await readdir(directory)) {
      const path = join(directory, entry),
        stat = await lstat(path);
      if (++count > 8192 || stat.isSymbolicLink() || !safeArchivePath(relative(destination, path)))
        throw new Error('mulnx_extracted_unsafe');
      if (stat.isDirectory()) await visit(path);
      else if (!stat.isFile() || stat.nlink !== 1 || (bytes += stat.size) > MAX_EXPANDED)
        throw new Error('mulnx_extracted_unsafe');
    }
  };
  await visit(destination);
  const root = resolve(destination, 'MulNX');
  for (const file of ['CS2Injector/CS2Injector.exe', 'CS2OBTool/CS2OBTool.dll']) {
    const stat = await lstat(join(root, file));
    if (!stat.isFile() || stat.size < 1024) throw new Error('mulnx_release_layout_unsupported');
  }
  const packs = await lstat(join(root, 'CS2OBTool/CameraSystem/CamPacks'));
  if (!packs.isDirectory()) throw new Error('mulnx_camera_resources_missing');
  for (const name of ['config.yaml', 'auto.yaml']) {
    const path = join(root, 'CS2Injector/CS2BootLoader/Config', name);
    const stat = await lstat(path);
    if (!stat.isFile() || stat.size > 64 * 1024) throw new Error('mulnx_launcher_config_invalid');
    const source = await readFile(path, 'utf8');
    if (
      name === 'config.yaml'
        ? (source.match(/^path\s*:/gm) ?? []).length !== 1
        : !/^autoLaunch\s*:\s*false\s*(?:#.*)?$/m.test(source)
    )
      throw new Error('mulnx_launcher_config_unsupported');
  }
  return { root, files: count, bytes };
}

export async function upstreamNotice(path: string, tag: string, readMetadata = publicJson) {
  const data = (await readMetadata(
    `https://api.github.com/repos/${MULNX_REPOSITORY}/contents/${path}?ref=${encodeURIComponent(tag)}`,
  )) as { encoding?: string; content?: string };
  if (data.encoding !== 'base64' || typeof data.content !== 'string')
    throw new Error('mulnx_notice_missing');
  return Buffer.from(data.content, 'base64');
}
