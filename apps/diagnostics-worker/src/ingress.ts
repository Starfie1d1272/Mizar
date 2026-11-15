/** Cloudflare supplies the peer address; only our fixed domestic ingress may
 * supply the client address. Its Caddy config overwrites the header from the
 * socket peer, so callers cannot choose a different rate-limit identity. */
export function diagnosticClientIp(request: Request): string | null {
  const peer = request.headers.get('cf-connecting-ip');
  if (peer !== '47.103.131.158') return peer;
  // Keep the legacy direct endpoint usable from the maintainer's server too.
  if (new URL(request.url).hostname !== 'diagnostics-origin.starfie1d.top') return peer;
  const client = request.headers.get('x-mizar-client-ip');
  // The ingress has an A record only; its public connections are IPv4.
  if (
    !client ||
    !/^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/.test(client) ||
    client.split('.').some((part) => Number(part) > 255)
  )
    return null;
  return client;
}
