import { setTimeout as delay } from 'node:timers/promises';
import { SourceLoadError } from './source-error.js';
import type { MatchContextSource } from './controller.js';

export interface OnlineManifestConfig {
  readonly urlTemplate: string;
  readonly readToken: string;
  readonly timeoutMs?: number;
  readonly retries?: number;
  readonly fetchImpl?: typeof fetch;
  readonly retryState?: { notBefore: number };
  readonly isCurrent?: () => boolean;
  readonly signal?: AbortSignal;
  readonly now?: () => number;
  readonly random?: () => number;
  readonly wait?: (ms: number) => Promise<void>;
}

function manifestUrl(template: string, matchId: string): URL {
  if (!template.includes('{matchId}') || template.replace('{matchId}', '').includes('{matchId}'))
    throw new Error('RivalHub Manifest URL 模板需要且仅需要一个 {matchId}。');
  const url = new URL(template.replace('{matchId}', encodeURIComponent(matchId)));
  if (url.username || url.password || url.hash)
    throw new Error('RivalHub Manifest URL 不允许凭据或 fragment。');
  if (
    url.protocol !== 'https:' &&
    !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
  )
    throw new Error('RivalHub Manifest URL 必须使用 HTTPS 或本机回环地址。');
  return url;
}

/** Request cancellation is best effort and never delays or retries the read itself. */
function discardManifestResponse(response: Response) {
  try {
    void response.body?.cancel().catch(() => undefined);
  } catch {
    // A broken/locked stream cannot turn rejection cleanup into another fetch.
  }
}

export function createOnlineManifestSource(
  matchId: string,
  config: OnlineManifestConfig,
): MatchContextSource {
  if (!matchId || matchId.length > 128 || !/^[a-zA-Z0-9_-]+$/.test(matchId))
    throw new Error('比赛标识格式有误。');
  const url = manifestUrl(config.urlTemplate, matchId);
  if (!config.readToken.trim()) throw new Error('RivalHub 只读凭据尚未配置。');
  const timeoutMs = config.timeoutMs ?? 3000;
  const retries = config.retries ?? 2;
  const fetchImpl = config.fetchImpl ?? fetch;
  const now = config.now ?? Date.now;
  const random = config.random ?? Math.random;
  const wait = config.wait ?? ((ms: number) => delay(ms, undefined, { signal: config.signal }));
  const retryState = config.retryState ?? { notBefore: 0 };
  const backoff = (attempt: number) => Math.min(4000, 500 * 2 ** attempt) * (1 + random());
  const current = () => {
    if (config.signal?.aborted || (config.isCurrent && !config.isCurrent()))
      throw new SourceLoadError('赛事连接已变化。', undefined, 'authorization');
  };
  return {
    kind: 'online',
    load: async () => {
      current();
      if (retryState.notBefore > now())
        throw new SourceLoadError('网站请求过于频繁，请稍后重试。', undefined, 'unavailable', 429);
      for (let attempt = 0; attempt <= retries; attempt++) {
        current();
        // Another match may extend this scope's cooldown while this read backs off.
        // Do not restart waiting or spend a request before the newer deadline.
        if (retryState.notBefore > now())
          throw new SourceLoadError(
            '网站请求过于频繁，请稍后重试。',
            undefined,
            'unavailable',
            429,
          );
        let response: Response | undefined;
        try {
          response = await fetchImpl(url, {
            headers: { Accept: 'application/json', Authorization: `Bearer ${config.readToken}` },
            redirect: 'manual',
            signal: config.signal
              ? AbortSignal.any([config.signal, AbortSignal.timeout(timeoutMs)])
              : AbortSignal.timeout(timeoutMs),
          });
          current();
          if (response.status === 401 || response.status === 403)
            throw new SourceLoadError(
              'RivalHub 只读凭据无效。',
              undefined,
              'authorization',
              response.status,
            );
          if (response.status >= 300 && response.status < 400)
            throw new SourceLoadError(
              'RivalHub Manifest 禁止跨地址重定向。',
              undefined,
              'invalid_response',
            );
          if (response.status === 429 || response.status >= 500) {
            let delay = backoff(attempt);
            if (response.status === 429) {
              const header = response.headers.get('retry-after');
              const seconds =
                header !== null && /^\d+(?:\.\d+)?$/.test(header.trim())
                  ? Number(header) * 1000
                  : NaN;
              const dateDelay = header === null ? NaN : Date.parse(header) - now();
              const retryAfter = Number.isFinite(seconds) ? seconds : dateDelay;
              if (Number.isFinite(retryAfter)) delay = Math.max(delay, retryAfter);
              retryState.notBefore = Math.max(retryState.notBefore, now() + delay);
            }
            discardManifestResponse(response);
            // A long Retry-After suppresses later timer reads too; do not hold a request open.
            if (attempt < retries && delay <= 8000) {
              await wait(delay);
              continue;
            }
          }
          if (!response.ok)
            throw new SourceLoadError(
              `RivalHub Manifest HTTP ${response.status}`,
              undefined,
              response.status === 404 ? 'not_found' : 'unavailable',
              response.status,
            );
          const input = await readOnlineManifestResponse(response);
          current();
          return input;
        } catch (error: unknown) {
          if (response) discardManifestResponse(response);
          current();
          if (error instanceof SourceLoadError) throw error;
          if (attempt === retries)
            throw new SourceLoadError(
              'RivalHub Manifest 暂时不可用。',
              error,
              error instanceof Error &&
                (error.name === 'TimeoutError' || error.name === 'AbortError')
                ? 'timeout'
                : 'network',
            );
          await wait(backoff(attempt));
        }
      }
      throw new SourceLoadError('RivalHub Manifest 暂时不可用。');
    },
  };
}

/** Shared bounded JSON reader for single-match responses, including browsing refreshes. */
export async function readOnlineManifestResponse(response: Response): Promise<unknown> {
  const size = Number(response.headers.get('content-length') ?? '0');
  if (size > 1_000_000)
    throw new SourceLoadError('RivalHub Manifest 响应过大。', undefined, 'invalid_response');
  if (!response.body)
    throw new SourceLoadError('RivalHub Manifest 响应为空。', undefined, 'invalid_response');
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 1_000_000)
        throw new SourceLoadError('RivalHub Manifest 响应过大。', undefined, 'invalid_response');
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const body = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(body) as unknown;
  } catch (error) {
    throw new SourceLoadError('RivalHub Manifest 格式无法读取。', error, 'invalid_response');
  }
}
