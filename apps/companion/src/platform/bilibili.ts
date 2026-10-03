export type PlatformLiveState = 'live' | 'offline' | 'unknown' | 'unconfigured';

export function bilibiliRoomId(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.port ||
      !['live.bilibili.com', 'www.live.bilibili.com'].includes(url.hostname)
    )
      return null;
    return /^\/([1-9]\d{0,15})\/?$/.exec(url.pathname)?.[1] ?? null;
  } catch {
    return null;
  }
}

/** One bounded cache shared by all local windows. Never fetch a supplied URL. */
export class BilibiliStatus {
  private cache = new Map<string, { at: number; state: PlatformLiveState }>();
  private pending = new Map<string, Promise<PlatformLiveState>>();
  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now = () => performance.now(),
  ) {}
  private async room(id: string): Promise<PlatformLiveState> {
    const cached = this.cache.get(id);
    if (cached && this.now() - cached.at < 30_000) return cached.state;
    const pending = this.pending.get(id);
    if (pending) return pending;
    if (this.pending.size >= 16) return 'unknown';
    const request = (async (): Promise<PlatformLiveState> => {
      let state: PlatformLiveState = 'unknown';
      try {
        const response = await this.fetchImpl(
          `https://api.live.bilibili.com/room/v1/Room/room_init?id=${id}`,
          { signal: AbortSignal.timeout(4000), redirect: 'error' },
        );
        if (response.ok && response.body) {
          const reader = (response.body as ReadableStream<Uint8Array>).getReader();
          const chunks: Uint8Array[] = [];
          let bytes = 0;
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              bytes += value.byteLength;
              if (bytes > 64_000) throw new Error('response too large');
              chunks.push(value);
            }
          } finally {
            await reader.cancel().catch(() => undefined);
          }
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
            code?: unknown;
            data?: { live_status?: unknown };
          };
          if (body.code === 0) {
            if (body.data?.live_status === 1) state = 'live';
            else if (body.data?.live_status === 0 || body.data?.live_status === 2)
              state = 'offline';
          }
        }
      } catch {
        /* Best effort: network failures remain unknown. */
      }
      if (this.cache.size >= 16) this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(id, { at: this.now(), state });
      return state;
    })();
    this.pending.set(id, request);
    try {
      return await request;
    } finally {
      this.pending.delete(id);
    }
  }
  async read(urls: readonly (string | null)[]): Promise<PlatformLiveState> {
    const ids = [
      ...new Set(urls.map(bilibiliRoomId).filter((id): id is string => id !== null)),
    ].slice(0, 16);
    if (!ids.length) return 'unconfigured';
    const states = await Promise.all(ids.map((id) => this.room(id)));
    return states.includes('live') ? 'live' : states.includes('unknown') ? 'unknown' : 'offline';
  }
}
