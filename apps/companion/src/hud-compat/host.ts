import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, realpath } from 'node:fs/promises';
import { extname, join, relative, isAbsolute } from 'node:path';
import { Server } from 'socket.io';
import type { ProjectionCoordinator } from '../projections/projection-coordinator.js';
import { mapProgramProjection } from '../local-protocol/program-wire.js';
import { mapRadarFrame } from '../local-protocol/radar-wire.js';
import { projectLhm } from './projection.js';
import { loadLhmMaps, type LhmMap } from './maps.js';
import type { SteamAvatars } from '../media/steam-avatars.js';
import { readLocalAsset } from '../match-context/local-assets.js';
import { lhmContext } from './context.js';
import { panelImageRefs } from './panel.js';

const types: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

/** Explicit development entry for a locally built LHM HUD; it does not install packages. */
export async function startLhmHost(options: {
  root: string;
  port: number;
  webRoot?: string;
  steamAvatars?: SteamAvatars;
  localAssetsDirectory?: string;
  projections: ProjectionCoordinator;
  config?: Record<string, unknown>;
}): Promise<{ url: string; close(): Promise<void> }> {
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535)
    throw new Error('Invalid LHM host port');
  const root = await realpath(options.root);
  const maps = options.webRoot ? await loadLhmMaps(options.webRoot) : new Map<string, LhmMap>();
  const panelImages = await panelImageRefs(root, options.config ?? {});
  let program = mapProgramProjection(options.projections.getCurrent().program);
  let context = lhmContext(program);
  let contextKey = JSON.stringify(context && { match: context.match, teams: context.teams });
  let current = projectLhm(
    mapProgramProjection(options.projections.getCurrent().program),
    mapRadarFrame(options.projections.getCurrent().radar),
  );
  const handleRequest = async (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; media-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'",
    );
    if (req.method !== 'GET' || req.headers.host !== `127.0.0.1:${options.port}`) {
      res.writeHead(403).end();
      return;
    }
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${options.port}`);
    const json = (value: unknown) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(value));
    };
    if (url.pathname === '/status') {
      json({
        ...(current.available ? { available: true } : current),
        unsupported: [
          'tournament',
          'external-logos-and-avatars',
          'multi-layer-maps-derived-fallback',
          ...(maps.has(program.map.name ?? '') ? [] : ['current-map']),
          ...(context ? [] : ['current-match']),
          'panel-image-import',
          'camera',
          'grenades',
          'events',
        ],
      });
      return;
    }
    if (url.pathname === '/api/camera') {
      json({ uuid: null, availablePlayers: [] });
      return;
    }
    if (url.pathname === '/api/game-maps/cs2') {
      json(
        [...maps].map(([name, map]) => ({
          lhmId: name,
          name,
          game: 'cs2',
          radars: map.radars,
        })),
      );
      return;
    }
    if (url.pathname === '/api/radar/maps') {
      json(
        Object.fromEntries(
          [...maps]
            .filter(([, map]) => map.config !== null)
            .map(([name, map]) => [
              name,
              { config: map.config, file: `/api/game-maps/cs2/image/${name}/radar` },
            ]),
        ),
      );
      return;
    }
    const radarImage = /^\/api\/game-maps\/cs2\/image\/(de_[a-z0-9]+)\/radar$/.exec(url.pathname);
    if (radarImage) {
      const map = maps.get(radarImage[1]!);
      if (!map) {
        res.writeHead(404).end();
        return;
      }
      res.setHeader('Content-Type', map.mime);
      res.end(map.bytes);
      return;
    }
    if (url.pathname === '/api/match/current') {
      json(context?.match ?? null);
      return;
    }
    const avatar = /^\/api\/players\/avatar\/steamid\/([^/]+)(?:\/(image))?$/.exec(url.pathname);
    if (avatar) {
      const player = program.players.find((item) => item.sourcePlayerId === avatar[1]);
      const filename = /^\/local\/v1\/steam-avatar\/([a-f0-9]{64}\.jpg)$/.exec(
        player?.avatarUrl ?? '',
      )?.[1];
      const bytes = filename ? await options.steamAvatars?.image(filename) : null;
      if (avatar[2]) {
        if (!bytes) {
          res.writeHead(404).end();
          return;
        }
        res.setHeader('Content-Type', 'image/jpeg');
        res.end(bytes);
        return;
      }
      json({
        custom: null,
        steam: bytes ? `/api/players/avatar/steamid/${avatar[1]}/image` : null,
      });
      return;
    }
    const teamLogo = /^\/api\/teams\/logo\/([^/]+)$/.exec(url.pathname);
    const panelImage = /^\/api\/huds\/mizar\/([\w-]+)\/([\w-]+)$/.exec(url.pathname);
    if (teamLogo || panelImage) {
      const ref = teamLogo
        ? context?.logos.get(teamLogo[1]!)
        : panelImages.get(`${panelImage![1]}/${panelImage![2]}`);
      const image =
        ref && options.localAssetsDirectory
          ? await readLocalAsset(options.localAssetsDirectory, ref)
          : null;
      if (!image) {
        res.writeHead(404).end();
        return;
      }
      res.setHeader('Content-Type', image.mime);
      res.end(image.bytes);
      return;
    }
    if (url.pathname === '/api/teams') {
      json(context?.teams ?? []);
      return;
    }
    const team = /^\/api\/teams\/([^/]+)$/.exec(url.pathname);
    if (team) {
      json(context?.teams.find((item) => item._id === team[1]) ?? null);
      return;
    }
    if (url.pathname === '/api/players') {
      const filter = url.searchParams.get('steamids');
      const requested = filter === null ? null : new Set(filter.split(';'));
      json(
        program.players
          .filter((player) => requested === null || requested.has(player.sourcePlayerId))
          .map((player) => ({
            _id: player.sourcePlayerId,
            steamid: player.sourcePlayerId,
            username: player.displayName,
            firstName: '',
            lastName: '',
            avatar: null,
            country: null,
            extra: {},
          })),
      );
      return;
    }
    if (['/api/tournament'].includes(url.pathname)) {
      json([]);
      return;
    }
    if (!url.pathname.startsWith('/huds/mizar/')) {
      res.writeHead(404).end();
      return;
    }
    try {
      const name = decodeURIComponent(url.pathname.slice('/huds/mizar/'.length));
      const file = await realpath(join(root, name));
      const rel = relative(root, file);
      const type = types[extname(file).toLowerCase()];
      if (!rel || rel.startsWith('..') || isAbsolute(rel) || !type) throw new Error('invalid file');
      const bytes = await readFile(file);
      res.setHeader('Content-Type', type);
      res.end(bytes);
    } catch {
      res.writeHead(404).end();
    }
  };
  const server = createServer((req, res) => {
    void handleRequest(req, res).catch(() => {
      res.writeHead(500).end();
    });
  });
  const registered = new Set<string>();
  const io = new Server(server, {
    allowRequest: (req, callback) =>
      callback(
        null,
        req.headers.host === `127.0.0.1:${options.port}` &&
          (!req.headers.origin || req.headers.origin === `http://127.0.0.1:${options.port}`),
      ),
  });
  io.on('connection', (socket) => {
    const register = (name: unknown, isDev: unknown, game: unknown, mode: unknown) => {
      if (name !== 'mizar' || isDev !== false || game !== 'cs2' || mode !== 'DEFAULT') return;
      registered.add(socket.id);
      socket.emit('hud_config', options.config ?? {});
      socket.emit('match');
      if (current.available) socket.emit('update', current.raw);
    };
    socket.on('register', register);
    socket.on('disconnect', () => registered.delete(socket.id));
    socket.on('started', () => {});
    // A reconnect does not re-emit started in the official client.
    socket.emit('readyToRegister');
  });
  const unsubscribe = options.projections.subscribePresentation((bundle) => {
    const wasAvailable = current.available;
    program = mapProgramProjection(bundle.program);
    context = lhmContext(program);
    const nextContextKey = JSON.stringify(
      context && { match: context.match, teams: context.teams },
    );
    current = projectLhm(program, mapRadarFrame(bundle.radar));
    if (wasAvailable && !current.available) {
      for (const socket of io.sockets.sockets.values())
        if (registered.has(socket.id)) socket.emit('refreshHUD');
    }
    if (current.available)
      for (const socket of io.sockets.sockets.values())
        if (registered.has(socket.id)) {
          socket.emit('update', current.raw);
          if (nextContextKey !== contextKey) socket.emit('match');
        }
    contextKey = nextContextKey;
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(options.port, '127.0.0.1', resolve);
    });
  } catch (error) {
    unsubscribe();
    await io.close();
    throw error;
  }
  return {
    url: `http://127.0.0.1:${options.port}/huds/mizar/index.html?isProd=1`,
    close: async () => {
      unsubscribe();
      await io.close();
    },
  };
}
