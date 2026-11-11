import type { FastifyInstance, FastifyRequest } from 'fastify';
import { PRIVATE_PAGE_PATHS } from '@mizar/protocol/local-pages';
import { isLoopbackHostHeader, type LocalWebOriginPolicy } from './origin-policy.js';
import { LOCAL_WEB_ROUTES, type LocalWebChannel } from './transport-constants.js';

/** Public program-time output is separate from private production and early information. */
export const LOCAL_CHANNEL_VISIBILITY: Record<LocalWebChannel, 'public' | 'operator'> = {
  program: 'public',
  radar: 'public',
  'program-cue': 'public',
  operator: 'operator',
  assist: 'operator',
};

const publicReads = new Set<string>([
  '/local/protocol',
  ...Object.entries(LOCAL_WEB_ROUTES)
    .filter(([channel]) => LOCAL_CHANNEL_VISIBILITY[channel as LocalWebChannel] === 'public')
    .map(([, route]) => route),
  '/local/v1/hud-config',
  '/local/v1/broadcast-display-config',
  '/local/v1/program-presentation',
  '/local/v1/broadcast-stats-program',
  '/local/v1/broadcast-assets',
  '/local/v1/bp',
  '/local/v1/bp-presentation',
]);

function isPrivateLocalPath(path: string): boolean {
  if (
    publicReads.has(path) ||
    path.startsWith('/local/v1/steam-avatar/') ||
    path.startsWith('/local/v1/local-assets/')
  )
    return false;
  return (
    path === '/health' ||
    path.startsWith('/local/') ||
    path.startsWith('/runtime/') ||
    PRIVATE_PAGE_PATHS.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))
  );
}

/** Match the router's path, including its decoded catch-all parameter. */
export function localRequestPath(request: FastifyRequest): string {
  const route = request.routeOptions.url;
  return route === '/*' ? `/${(request.params as { '*': string })['*']}` : (route ?? '');
}

export function registerLocalWebAccess(app: FastifyInstance, policy: LocalWebOriginPolicy): void {
  // WebSocket upgrade bookkeeping runs in onRequest; check access before parsing a body.
  app.addHook('preParsing', async (request, reply) => {
    if (!isPrivateLocalPath(localRequestPath(request))) return;
    // Absolute-form requests carry their own authority (RFC 9112 §3.2.2).
    const authority = request.url.startsWith('/')
      ? request.headers.host
      : /^https?:\/\/([^/?#]+)/i.exec(request.url)?.[1];
    if (policy.mode === 'lan' || !isLoopbackHostHeader(authority))
      return reply.code(403).send({ error: 'private_surface_loopback_only' });
  });
}
