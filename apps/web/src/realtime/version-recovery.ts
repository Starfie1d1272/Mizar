import {
  LOCAL_PROTOCOL_SUBPROTOCOL,
  LOCAL_CHANNEL_VERSIONS,
  type LocalChannel,
} from '@mizar/protocol/version';

interface ProtocolIdentity {
  readonly subprotocol: string;
  readonly channels: Partial<Record<LocalChannel, number>>;
}

function identity(value: unknown): ProtocolIdentity | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.subprotocol !== 'string' ||
    typeof candidate.channels !== 'object' ||
    candidate.channels === null
  )
    return null;
  const channels = candidate.channels as Record<string, unknown>;
  if (
    !Object.values(channels).every(
      (version) => Number.isSafeInteger(version) && (version as number) > 0,
    )
  )
    return null;
  return candidate as unknown as ProtocolIdentity;
}

function matches(
  server: ProtocolIdentity,
  client: ProtocolIdentity,
  channel: LocalChannel,
): boolean {
  return (
    server.subprotocol === client.subprotocol &&
    server.channels[channel] !== undefined &&
    server.channels[channel] === client.channels[channel]
  );
}

async function fetchBody(url: string): Promise<string> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        const response = await fetch(url, { cache: 'no-store', signal: controller.signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.text();
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error('version request timeout'));
        }, 3000);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function reserveReload(target: string): boolean {
  const key = 'mizar.local.protocol.reload-attempts';
  const raw = sessionStorage.getItem(key);
  const attempts: unknown = raw === null ? [] : JSON.parse(raw);
  if (!Array.isArray(attempts) || attempts.length >= 64) return false;
  if (
    !attempts.every(
      (item) =>
        typeof item === 'object' &&
        item !== null &&
        typeof item.target === 'string' &&
        typeof item.at === 'number',
    )
  )
    return false;
  const now = Date.now();
  if (attempts.some((item) => item.target === target)) return false;
  if (attempts.filter((item) => now - item.at < 60_000).length >= 3) return false;
  sessionStorage.setItem(key, JSON.stringify([...attempts, { target, at: now }]));
  return true;
}

/** Recheck a known mismatch without reconnecting while its page is unavailable. */
export async function recoverChannelVersion(
  channel: LocalChannel,
  knownMismatch = false,
): Promise<'retry' | 'recheck' | 'incompatible' | 'reload'> {
  if (typeof window === 'undefined') return 'retry';
  let server: ProtocolIdentity | null;
  try {
    server = identity(JSON.parse(await fetchBody('/local/protocol')) as unknown);
  } catch {
    return knownMismatch ? 'recheck' : 'retry';
  }
  if (server === null) return knownMismatch ? 'recheck' : 'retry';
  // Older servers advertise only snapshot channels; absence does not prove cue incompatibility.
  if (server.subprotocol === LOCAL_PROTOCOL_SUBPROTOCOL && server.channels[channel] === undefined)
    return knownMismatch ? 'recheck' : 'retry';
  if (
    matches(
      server,
      { subprotocol: LOCAL_PROTOCOL_SUBPROTOCOL, channels: LOCAL_CHANNEL_VERSIONS },
      channel,
    )
  )
    return 'retry';

  let page: string;
  try {
    page = await fetchBody(window.location.pathname + window.location.search);
  } catch {
    return 'recheck';
  }
  try {
    const html = new DOMParser().parseFromString(page, 'text/html');
    const meta = html.querySelector('meta[name="mizar-local-protocol"]')?.getAttribute('content');
    const resource = html.querySelector('script[type="module"][src]')?.getAttribute('src');
    const current = document.querySelector('script[type="module"][src]')?.getAttribute('src');
    if (!meta || !resource || !current) return 'incompatible';
    const next = identity(JSON.parse(meta) as unknown);
    const nextUrl = new URL(resource, window.location.href);
    const currentUrl = new URL(current, window.location.href);
    if (
      !next ||
      !matches(server, next, channel) ||
      nextUrl.origin !== window.location.origin ||
      nextUrl.href === currentUrl.href
    )
      return 'incompatible';
    return reserveReload(nextUrl.href) ? 'reload' : 'incompatible';
  } catch {
    // A reload without a durable budget risks a loop.
    return 'incompatible';
  }
}
