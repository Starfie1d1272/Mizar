import { SourceLoadError } from './source-error.js';
import type { MatchContextSource } from './controller.js';

export interface OnlineManifestConfig {
  readonly urlTemplate: string;
  readonly readToken: string;
  readonly timeoutMs?: number;
  readonly retries?: number;
  readonly fetchImpl?: typeof fetch;
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
  return {
    kind: 'online',
    load: async () => {
      for (let attempt = 0; attempt <= retries; attempt++) {
        try {
          const response = await fetchImpl(url, {
            headers: { Accept: 'application/json', Authorization: `Bearer ${config.readToken}` },
            redirect: 'manual',
            signal: AbortSignal.timeout(timeoutMs),
          });
          if (response.status === 401 || response.status === 403)
            throw new SourceLoadError('RivalHub 只读凭据无效。');
          if (response.status >= 300 && response.status < 400)
            throw new SourceLoadError('RivalHub Manifest 禁止跨地址重定向。');
          if ((response.status === 429 || response.status >= 500) && attempt < retries) continue;
          if (!response.ok) throw new SourceLoadError(`RivalHub Manifest HTTP ${response.status}`);
          const size = Number(response.headers.get('content-length') ?? '0');
          if (size > 1_000_000) throw new SourceLoadError('RivalHub Manifest 响应过大。');
          if (!response.body) throw new SourceLoadError('RivalHub Manifest 响应为空。');
          const reader = (response.body as ReadableStream<Uint8Array>).getReader();
          const chunks: Uint8Array[] = [];
          let bytes = 0;
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              bytes += value.byteLength;
              if (bytes > 1_000_000) throw new SourceLoadError('RivalHub Manifest 响应过大。');
              chunks.push(value);
            }
          } finally {
            await reader.cancel().catch(() => undefined);
          }
          const body = Buffer.concat(chunks).toString('utf8');
          return JSON.parse(body) as unknown;
        } catch (error: unknown) {
          if (error instanceof SourceLoadError) throw error;
          if (attempt === retries)
            throw new SourceLoadError('RivalHub Manifest 暂时不可用。', error);
        }
      }
      throw new SourceLoadError('RivalHub Manifest 暂时不可用。');
    },
  };
}
