import net from 'node:net';

export type FetchLike = typeof globalThis.fetch;

const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const SENSITIVE_HEADERS = new Set(['authorization', 'proxy-authorization', 'cookie']);

export class DistributionHttpError extends Error {
  rateLimited = false;
  constructor(
    message: string,
    readonly source: string,
    readonly status?: number,
    cause?: unknown,
  ) {
    super(message, { cause });
    this.name = 'DistributionHttpError';
  }
}

export function validateHttpsUrl(raw: string | URL): URL {
  const url = raw instanceof URL ? new URL(raw.href) : new URL(raw);
  if (url.protocol !== 'https:') throw new Error('distribution_url_forbidden');
  if (url.port && url.port !== '443') throw new Error('distribution_url_forbidden');
  if (url.username || url.password) throw new Error('distribution_url_forbidden');
  const rawHost = url.hostname.toLowerCase();
  const host = rawHost.startsWith('[') && rawHost.endsWith(']') ? rawHost.slice(1, -1) : rawHost;
  if (host === 'localhost' || host.endsWith('.localhost') || net.isIP(host) !== 0) {
    throw new Error('distribution_url_forbidden');
  }
  return url;
}

export interface FetchHttpsOptions {
  signal: AbortSignal;
  fetcher?: FetchLike | undefined;
  headers?: Record<string, string>;
  range?: { start?: number; end: number };
  allowCompressedJson?: boolean;
  allowCompressedText?: boolean;
  userAgent?: string;
}

export async function fetchHttps(input: string, options: FetchHttpsOptions): Promise<Response> {
  const fetcher = options.fetcher ?? globalThis.fetch;
  if (options.range !== undefined) {
    const start = options.range.start ?? 0;
    const end = options.range.end;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) {
      throw new Error('distribution_range_invalid');
    }
  }

  let url = validateHttpsUrl(input);
  const initialOrigin = url.origin;

  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    options.signal.throwIfAborted();
    url = validateHttpsUrl(url);

    const sameOrigin = url.origin === initialOrigin;
    const headers: Record<string, string> = {
      Accept: '*/*',
      'User-Agent': options.userAgent ?? 'Mizar-Distribution',
    };
    if (options.headers) {
      for (const [key, value] of Object.entries(options.headers)) {
        if (!sameOrigin && SENSITIVE_HEADERS.has(key.toLowerCase())) continue;
        headers[key] = value;
      }
    }
    if (options.range !== undefined) {
      const start = options.range.start ?? 0;
      headers.Range = `bytes=${start}-${options.range.end}`;
    }

    const response = await fetcher(url, {
      redirect: 'manual',
      signal: options.signal,
      cache: 'no-store',
      headers,
    }).catch((cause: unknown) => {
      throw new DistributionHttpError(
        'distribution_network_failed',
        url.hostname,
        undefined,
        cause,
      );
    });

    if (REDIRECT_STATUSES.has(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel().catch(() => undefined);
      if (!location) throw new Error('distribution_redirect_invalid');
      if (redirects === MAX_REDIRECTS) throw new Error('distribution_redirect_limit');
      url = validateHttpsUrl(new URL(location, url));
      continue;
    }

    if (!response.ok || !response.body) {
      const error = new DistributionHttpError(
        'distribution_network_failed',
        url.hostname,
        response.status,
      );
      error.rateLimited =
        url.hostname === 'api.github.com' && response.headers.get('x-ratelimit-remaining') === '0';
      await response.body?.cancel().catch((cause: unknown) => {
        error.cause = cause;
      });
      throw error;
    }

    const encoding = response.headers.get('content-encoding');
    if (encoding && encoding !== 'identity') {
      const contentType = response.headers.get('content-type') ?? '';
      const isJson = options.allowCompressedJson && contentType.toLowerCase().includes('json');
      const isText =
        options.allowCompressedText &&
        encoding.toLowerCase() === 'gzip' &&
        /^text\/plain(?:\s*;|$)/i.test(contentType);
      if (!isJson && !isText) {
        await response.body.cancel().catch(() => undefined);
        throw new Error('distribution_encoding_invalid');
      }
    }

    return response;
  }

  throw new Error('distribution_redirect_limit');
}

export async function boundedBytes(response: Response, limit: number): Promise<Buffer> {
  const size = Number(response.headers.get('content-length'));
  const encoding = response.headers.get('content-encoding');
  if ((!encoding || encoding === 'identity') && Number.isFinite(size) && size > limit) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error('distribution_response_too_large');
  }
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  const reader = response.body!.getReader() as ReadableStreamDefaultReader<Uint8Array>;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.length;
      if (bytes > limit) throw new Error('distribution_response_too_large');
      chunks.push(next.value);
    }
    return Buffer.concat(chunks, bytes);
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

export async function fetchJson(
  url: string,
  options: FetchHttpsOptions & { maxBytes?: number },
): Promise<unknown> {
  const response = await fetchHttps(url, {
    ...options,
    allowCompressedJson: options.allowCompressedJson ?? true,
  });
  const bytes = await boundedBytes(response, options.maxBytes ?? 256 * 1024);
  return JSON.parse(bytes.toString('utf8')) as unknown;
}
