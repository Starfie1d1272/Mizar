import { UpdateRequestError } from './diagnostics.js';
import { BOX_READ_TOKEN, UPDATE_REPOSITORY } from './contract.js';

export type UpdateFetch = typeof globalThis.fetch;
export function allowedUpdateUrl(url: URL): boolean {
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash)
    return false;
  if (url.hostname === 'api.github.com')
    return url.pathname.startsWith(`/repos/${UPDATE_REPOSITORY}/`);
  if (url.hostname === 'github.com')
    return url.pathname.startsWith(`/${UPDATE_REPOSITORY}/releases/download/`);
  if (url.hostname === 'release-assets.githubusercontent.com') return true;
  if (url.hostname === 'box.nju.edu.cn')
    return (
      url.pathname.startsWith('/d/91dec4c27e5d47f38fcf/') ||
      url.pathname.startsWith('/api/v2.1/share-links/91dec4c27e5d47f38fcf/') ||
      ['/api/v2.1/via-repo-token/dir/', '/api/v2.1/via-repo-token/download-link/'].includes(
        url.pathname,
      ) ||
      url.pathname.startsWith('/seafhttp/files/')
    );
  return false;
}
export async function updateRequest(
  input: string,
  signal: AbortSignal,
  fetcher: UpdateFetch = globalThis.fetch,
): Promise<Response> {
  let url = new URL(input);
  for (let redirects = 0; redirects < 5; redirects++) {
    if (!allowedUpdateUrl(url)) throw new Error('update_url_forbidden');
    const response = await fetcher(url, {
      redirect: 'manual',
      signal,
      cache: 'no-store',
      headers: {
        ...(url.origin === 'https://box.nju.edu.cn' &&
        ['/api/v2.1/via-repo-token/dir/', '/api/v2.1/via-repo-token/download-link/'].includes(
          url.pathname,
        )
          ? { Authorization: `Token ${BOX_READ_TOKEN}` }
          : {}),
        Accept: url.hostname === 'api.github.com' ? 'application/vnd.github+json' : '*/*',
        'User-Agent': 'Mizar-Stable-Updater',
      },
    }).catch((cause: unknown) => {
      throw new UpdateRequestError('update_network_failed', url.hostname, undefined, cause);
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location) throw new Error('update_redirect_invalid');
      url = new URL(location, url);
      continue;
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new UpdateRequestError('update_network_failed', url.hostname, response.status);
    }
    if (
      response.headers.get('content-encoding') &&
      response.headers.get('content-encoding') !== 'identity'
    ) {
      // JSON can be encoded; installer byte counts always apply to the decoded stream.
      if (!response.headers.get('content-type')?.includes('json')) {
        await response.body.cancel();
        throw new Error('update_encoding_invalid');
      }
    }
    return response;
  }
  throw new Error('update_redirect_limit');
}
export async function boundedBytes(response: Response, limit: number): Promise<Buffer> {
  const size = Number(response.headers.get('content-length'));
  if (Number.isFinite(size) && size > limit) {
    await response.body?.cancel();
    throw new Error('update_response_too_large');
  }
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  const reader = response.body!.getReader() as ReadableStreamDefaultReader<Uint8Array>;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.length;
      if (bytes > limit) throw new Error('update_response_too_large');
      chunks.push(next.value);
    }
    return Buffer.concat(chunks, bytes);
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}
export async function updateJson(
  url: string,
  signal: AbortSignal,
  fetcher?: UpdateFetch,
  limit = 256 * 1024,
): Promise<unknown> {
  return JSON.parse(
    (await boundedBytes(await updateRequest(url, signal, fetcher), limit)).toString('utf8'),
  ) as unknown;
}
