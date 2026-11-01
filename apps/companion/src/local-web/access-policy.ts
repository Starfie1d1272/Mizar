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

export function localRouteVisibility(path: string): 'public' | 'operator' | 'host-runtime' {
  if (path.startsWith('/operator/runtime/') || path.startsWith('/runtime/')) return 'host-runtime';
  if (
    publicReads.has(path) ||
    path.startsWith('/local/v1/steam-avatar/') ||
    path.startsWith('/local/v1/local-assets/')
  )
    return 'public';
  if (
    path.startsWith('/local/') ||
    path === '/health' ||
    ['/debug', '/operator', '/workspace', '/matches', '/packages', '/picture', '/settings'].some(
      (prefix) => path === prefix || path.startsWith(`${prefix}/`),
    ) ||
    path === '/'
  )
    return 'operator';
  // Public static program assets and authenticated GSI retain their existing handlers.
  return 'public';
}
