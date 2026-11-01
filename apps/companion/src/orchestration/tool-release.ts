import { z } from 'zod';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, mkdir, open, readdir, readFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { transfer } from '../distribution/transfer.js';
import { sourceOrder, forgetSourceOrder, type SourceDiagnostic } from '../distribution/sources.js';

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

/** Build/sync only: callers supply their authenticated metadata reader; no client fallback. */
export async function latestMulnxRelease(
  readMetadata: (url: string) => Promise<unknown>,
): Promise<MulnxRelease> {
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

async function assetRequest(input: string, signal: AbortSignal, end?: number, proxy = false) {
  const origin = new URL(input);
  if (
    origin.protocol !== 'https:' ||
    origin.hostname !== 'github.com' ||
    origin.username ||
    origin.password ||
    origin.port ||
    origin.search ||
    origin.hash ||
    !(
      origin.pathname.startsWith(`/${MULNX_REPOSITORY}/releases/download/`) ||
      origin.href === SEVEN_ZIP.url
    )
  )
    throw new Error('mulnx_url_forbidden');
  const proxyUrl = `https://gh-proxy.com/${origin.href}`;
  let current = new URL(proxy ? proxyUrl : origin.href);
  for (let redirects = 0; redirects < 5; redirects++) {
    const allowed =
      current.href === origin.href ||
      (proxy && current.href === proxyUrl) ||
      (current.protocol === 'https:' &&
        current.hostname === 'release-assets.githubusercontent.com' &&
        !current.username &&
        !current.password &&
        !current.port &&
        !current.hash);
    if (!allowed) throw new Error('mulnx_url_forbidden');
    const response = await fetch(current, {
      redirect: 'manual',
      signal,
      ...(end === undefined ? {} : { headers: { Range: `bytes=0-${end}` } }),
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get('location');
    await response.body?.cancel();
    if (!location) throw new Error('mulnx_redirect_invalid');
    current = new URL(location, current);
  }
  throw new Error('mulnx_redirect_limit');
}

export async function downloadVerified(
  url: string,
  target: string,
  sha256: string,
  expectedSize?: number,
  signal: AbortSignal = AbortSignal.timeout(120_000),
  progress?: (bytes: number, source: number, name: string) => void,
  mirror?: (signal: AbortSignal, end?: number) => Promise<Response>,
  fallback?: (error: unknown, name: string) => void,
  verifying?: () => void,
  selectSources = false,
  report?: (diagnostic: SourceDiagnostic & { candidates: string[] }) => void,
) {
  const isMulnx =
    selectSources &&
    expectedSize !== undefined &&
    url.startsWith(`https://github.com/${MULNX_REPOSITORY}/releases/download/`);
  const sources = [
    {
      name: 'GitHub',
      request: (attempt: AbortSignal, end?: number) => assetRequest(url, attempt, end),
    },
    ...(isMulnx
      ? [
          {
            name: 'GitHub 加速',
            request: (attempt: AbortSignal, end?: number) => assetRequest(url, attempt, end, true),
          },
        ]
      : []),
    ...(mirror ? [{ name: '南大云盘', request: mirror }] : []),
  ];
  const key = `mulnx:${url}:${sha256}:${expectedSize ?? 0}:${sources.map((source) => source.name).join(',')}`;
  const order = isMulnx
    ? await sourceOrder(
        key,
        expectedSize,
        signal,
        sources.map((source) => source.request),
        (diagnostic) => report?.({ ...diagnostic, candidates: sources.map((entry) => entry.name) }),
      )
    : sources.map((_, index) => index);
  try {
    await transfer({
      target,
      ...(expectedSize === undefined ? {} : { bytes: expectedSize }),
      maxBytes: MAX_ARCHIVE,
      sha256,
      integrityError: 'mulnx_download_integrity',
      signal,
      progress: (bytes, source) => progress?.(bytes, source, sources[order[source]!]!.name),
      fallback: (error, source) => {
        forgetSourceOrder(key);
        fallback?.(error, sources[order[source]!]!.name);
      },
      verifying: () => verifying?.(),
      sources: order.map((index) => (attempt) => sources[index]!.request(attempt)),
    });
  } catch (error) {
    if (!signal.aborted) forgetSourceOrder(key);
    throw error;
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

export async function upstreamNotice(
  path: string,
  tag: string,
  readMetadata: (url: string) => Promise<unknown>,
) {
  const data = (await readMetadata(
    `https://api.github.com/repos/${MULNX_REPOSITORY}/contents/${path}?ref=${encodeURIComponent(tag)}`,
  )) as { encoding?: string; content?: string };
  if (data.encoding !== 'base64' || typeof data.content !== 'string')
    throw new Error('mulnx_notice_missing');
  return Buffer.from(data.content, 'base64');
}
