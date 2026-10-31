import {
  LOCAL_PROTOCOL_SUBPROTOCOL,
  LOCAL_SNAPSHOT_VERSIONS,
  type LocalSnapshotChannel,
} from '@mizar/protocol/version';

interface ProtocolIdentity {
  readonly subprotocol: string;
  readonly channels: Partial<Record<LocalSnapshotChannel, number>>;
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
  channel: LocalSnapshotChannel,
): boolean {
  return (
    server.subprotocol === client.subprotocol &&
    server.channels[channel] !== undefined &&
    server.channels[channel] === client.channels[channel]
  );
}

async function fetchNoCache(url: string): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);
  try {
    return await fetch(url, { cache: 'no-store', signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

/** Returns retry on an unavailable/unrecognized endpoint, never guessing compatibility. */
export async function recoverChannelVersion(
  channel: LocalSnapshotChannel,
): Promise<'retry' | 'incompatible' | 'reload'> {
  if (typeof window === 'undefined') return 'retry';
  let server: ProtocolIdentity | null;
  try {
    const response = await fetchNoCache('/local/protocol');
    if (!response.ok) return 'retry';
    server = identity(await response.json());
  } catch {
    return 'retry';
  }
  if (server === null) return 'retry';
  if (
    matches(
      server,
      { subprotocol: LOCAL_PROTOCOL_SUBPROTOCOL, channels: LOCAL_SNAPSHOT_VERSIONS },
      channel,
    )
  )
    return 'retry';

  let page: string;
  try {
    const response = await fetchNoCache(window.location.pathname + window.location.search);
    if (!response.ok) return 'retry';
    page = await response.text();
  } catch {
    return 'retry';
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
    // A single attempt per tab remains bounded even if versions or asset names oscillate.
    const key = 'mizar.local.protocol.reload-attempted';
    if (sessionStorage.getItem(key) !== null) return 'incompatible';
    sessionStorage.setItem(key, '1');
    return 'reload';
  } catch {
    // Without durable session storage a reload loop cannot be ruled out.
    return 'incompatible';
  }
}
