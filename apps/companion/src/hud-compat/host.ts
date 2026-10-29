import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, realpath } from 'node:fs/promises';
import { extname, join, relative, isAbsolute } from 'node:path';
import { Server } from 'socket.io';
import type { ProjectionCoordinator } from '../projections/projection-coordinator.js';
import { mapProgramProjection } from '../local-protocol/program-wire.js';
import { mapRadarFrame } from '../local-protocol/radar-wire.js';
import { projectLhm } from './projection.js';

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
  projections: ProjectionCoordinator;
  config?: Record<string, unknown>;
}): Promise<{ url: string; close(): Promise<void> }> {
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535)
    throw new Error('Invalid LHM host port');
  const root = await realpath(options.root);
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
          'match',
          'tournament',
          'avatars',
          'map-directory',
          'panel-images',
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
    if (url.pathname === '/api/match/current') {
      json(null);
      return;
    }
    if (url.pathname.startsWith('/api/players/avatar/steamid/')) {
      json({ custom: null, steam: null });
      return;
    }
    if (
      [
        '/api/players',
        '/api/teams',
        '/api/tournament',
        '/api/game-maps/cs2',
        '/api/radar/maps',
      ].includes(url.pathname)
    ) {
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
    current = projectLhm(mapProgramProjection(bundle.program), mapRadarFrame(bundle.radar));
    if (wasAvailable && !current.available) {
      for (const socket of io.sockets.sockets.values())
        if (registered.has(socket.id)) socket.emit('refreshHUD');
    }
    if (current.available)
      for (const socket of io.sockets.sockets.values())
        if (registered.has(socket.id)) socket.emit('update', current.raw);
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
