import { existsSync, statSync } from 'node:fs';
import { extname } from 'node:path';
import { fileURLToPath } from 'node:url';

import fastifyStatic from '@fastify/static';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

const SURFACE_ROUTES = [
  '/program',
  '/program/bp',
  '/operator',
  '/operator/bp',
  '/operator/hud',
  '/debug',
] as const;
const RESERVED_PREFIXES = [
  '/debug',
  '/operator/series',
  '/operator/bp-command',
  '/operator/bp-local-save',
  '/operator/bp-rivalhub',
  '/gsi',
  '/health',
  '/local/v1',
  '/qualification',
] as const;

export interface StaticHostOptions {
  readonly webRoot?: string;
  readonly qualificationMode?: boolean;
}

function defaultWebRoot(): string {
  return fileURLToPath(new URL('../../../web/dist/', import.meta.url));
}

function hasIndexFile(root: string): boolean {
  return existsSync(root) && statSync(root).isDirectory() && existsSync(`${root}/index.html`);
}

function shouldLeaveForApi(pathname: string): boolean {
  return RESERVED_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

function setCacheHeader(reply: FastifyReply, value: string): void {
  reply.header('cache-control', value);
}

function pathFromRequest(request: FastifyRequest): string {
  const pathname = request.url.split('?', 1)[0] ?? '/';
  return pathname.replace(/^\/+/, '');
}

function sendStaticFile(reply: FastifyReply, filename: string, cacheControl: string): FastifyReply {
  const response = reply.sendFile(filename, { cacheControl: false });
  setCacheHeader(response, cacheControl);
  return response;
}

export function registerStaticHost(app: FastifyInstance, options: StaticHostOptions = {}): boolean {
  const explicitRoot = options.webRoot !== undefined;
  const root = options.webRoot ?? defaultWebRoot();
  if (!hasIndexFile(root)) {
    if (explicitRoot) {
      throw new Error(`WEB_ROOT 必须是包含 index.html 的目录：${root}`);
    }
    app.log.warn({ root }, '网页构建产物不存在；继续提供 HTTP API 与 WebSocket 服务');
    return false;
  }

  app.register(fastifyStatic, {
    root,
    wildcard: false,
    index: false,
    cacheControl: false,
    setHeaders: (reply, pathname) => {
      const normalizedPath = pathname.replaceAll('\\', '/');
      const cacheControl = normalizedPath.endsWith('/index.html')
        ? 'no-store'
        : normalizedPath.includes('/assets/')
          ? 'public, max-age=31536000, immutable'
          : 'no-cache';
      setCacheHeader(reply, cacheControl);
    },
  });

  app.get('/', async (_request, reply) => reply.redirect('/operator'));
  if (!options.qualificationMode) {
    app.get('/qualification', async (_request, reply) =>
      sendStaticFile(reply, 'index.html', 'no-store'),
    );
  }

  for (const route of SURFACE_ROUTES) {
    app.get(route, async (_request, reply) => sendStaticFile(reply, 'index.html', 'no-store'));
  }

  app.get('/assets/*', async (request, reply) => {
    const assetPath = pathFromRequest(request);
    return sendStaticFile(reply, assetPath, 'public, max-age=31536000, immutable');
  });

  app.get('/*', async (request, reply) => {
    const pathname = request.url.split('?', 1)[0] ?? '/';
    if (shouldLeaveForApi(pathname)) return reply.callNotFound();
    const filename = pathFromRequest(request);
    if (filename.length === 0) return reply.callNotFound();
    if (extname(filename) === '' && request.headers.accept?.includes('text/html')) {
      reply.code(404);
      return sendStaticFile(reply, 'index.html', 'no-store');
    }
    return sendStaticFile(reply, filename, 'no-cache');
  });

  return true;
}
