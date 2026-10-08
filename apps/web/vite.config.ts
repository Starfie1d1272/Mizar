import { defineConfig } from 'vite';
import { cp, readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import react from '@vitejs/plugin-react';

const cs2AssetsPublicDir = '../../packages/cs2-assets/generated/public';
const replayPublicDir = resolve(import.meta.dirname, 'public');
const repositoryRoot = resolve(import.meta.dirname, '../..');

const replaySources = {
  'epl-inferno-opening': {
    capturePath: resolve(repositoryRoot, 'fixtures/epl-s24/captures/inferno-opening'),
    firstSequence: 13,
    lastSequence: 650,
  },
  'epl-inferno-final-round': {
    capturePath: resolve(repositoryRoot, 'fixtures/epl-s24/captures/inferno-final-round'),
    firstSequence: 2200,
    lastSequence: 3160,
  },
  'ancient-round-03': {
    capturePath: resolve(repositoryRoot, 'fixtures/gsi/acceptance/ancient-round-03'),
    firstSequence: 587,
    lastSequence: 1214,
  },
  'ancient-round-11-defuse': {
    capturePath: resolve(repositoryRoot, 'fixtures/gsi/acceptance/ancient-round-11-defuse'),
    firstSequence: 5522,
    lastSequence: 5544,
  },
} as const;

async function readJsonRequest(request: AsyncIterable<Uint8Array>): Promise<unknown> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.byteLength;
    if (size > 4_096) throw new Error('Replay request is too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

function replayPrefixDevelopmentApi() {
  return {
    name: 'mizar-replay-prefix-development-api',
    configureServer(server: import('vite').ViteDevServer) {
      type ReplayModule = {
        readonly replayRealProgram: (options: {
          readonly capturePath: string;
          readonly targetSequence: number;
          readonly configureManifest?: () => unknown;
        }) => Promise<{
          readonly snapshot: unknown;
          readonly radarSnapshot: unknown;
        }>;
      };
      server.middlewares.use('/__local/replay-prefix', (request, response, next) => {
        if (request.method !== 'POST') return next();
        void (async () => {
          const body = await readJsonRequest(request);
          if (typeof body !== 'object' || body === null || Array.isArray(body)) {
            throw new Error('Invalid replay request');
          }
          const { sourceId, targetSequence } = body as {
            readonly sourceId?: unknown;
            readonly targetSequence?: unknown;
          };
          if (
            typeof sourceId !== 'string' ||
            !Object.hasOwn(replaySources, sourceId) ||
            typeof targetSequence !== 'number' ||
            !Number.isSafeInteger(targetSequence)
          ) {
            throw new Error('Invalid replay source or sequence');
          }
          const source = replaySources[sourceId as keyof typeof replaySources];
          if (targetSequence < source.firstSequence || targetSequence > source.lastSequence) {
            throw new Error('Replay sequence is outside the fixed source selection');
          }
          const { replayRealProgram } = (await server.ssrLoadModule(
            `/@fs/${resolve(repositoryRoot, 'apps/companion/test/support/real-program-replay.ts')
              .split(sep)
              .join('/')}`,
          )) as unknown as ReplayModule;
          let result: Awaited<ReturnType<ReplayModule['replayRealProgram']>>;
          try {
            const eplContext = sourceId.startsWith('epl-')
              ? (JSON.parse(
                  await readFile(
                    resolve(replayPublicDir, 'fixtures', sourceId, 'replay/match-context.json'),
                    'utf8',
                  ),
                ) as { manifest: unknown })
              : undefined;
            result = await replayRealProgram({
              capturePath: source.capturePath,
              targetSequence,
              ...(eplContext ? { configureManifest: () => eplContext.manifest } : {}),
            });
          } catch (error) {
            let sanitizerVersion: unknown = 'unreadable';
            try {
              const manifest = JSON.parse(
                await readFile(resolve(source.capturePath, 'manifest.json'), 'utf8'),
              ) as { readonly provenance?: { readonly sanitizerVersion?: unknown } };
              sanitizerVersion = manifest.provenance?.sanitizerVersion ?? 'missing';
            } catch {
              // Keep the original replay error authoritative; diagnostics are best-effort.
            }
            const message = error instanceof Error ? error.message : 'Replay rebuild failed';
            throw new Error(
              `current-worktree testkit source · capture sanitizer v${String(sanitizerVersion)} · ${message}`,
              { cause: error },
            );
          }
          response.statusCode = 200;
          response.setHeader('Content-Type', 'application/json; charset=utf-8');
          response.setHeader('Cache-Control', 'no-store');
          response.end(
            JSON.stringify({
              targetSequence,
              program: result.snapshot,
              radar: result.radarSnapshot,
            }),
          );
        })().catch((error: unknown) => {
          if (response.headersSent) return;
          response.statusCode = 400;
          response.setHeader('Content-Type', 'application/json; charset=utf-8');
          response.setHeader('Cache-Control', 'no-store');
          response.end(
            JSON.stringify({
              error: error instanceof Error ? error.message : 'Replay rebuild failed',
            }),
          );
        });
      });
    },
  };
}

function replayPublicAssets() {
  return {
    name: 'mizar-replay-public-assets',
    configureServer(server: import('vite').ViteDevServer) {
      server.middlewares.use('/fixtures', (request, response, next) => {
        const requestUrl = request.url;
        if (requestUrl === undefined) return next();
        let pathname: string;
        try {
          pathname = decodeURIComponent(new URL(requestUrl, 'http://localhost').pathname);
        } catch {
          return next();
        }
        const filePath = resolve(replayPublicDir, 'fixtures', `.${pathname}`);
        if (!filePath.startsWith(`${replayPublicDir}${sep}`)) return next();
        void readFile(filePath)
          .then((bytes) => {
            const contentTypes: Record<string, string> = {
              '.json': 'application/json; charset=utf-8',
              '.jsonl': 'application/x-ndjson; charset=utf-8',
              '.jpg': 'image/jpeg',
              '.png': 'image/png',
              '.svg': 'image/svg+xml',
            };
            response.statusCode = 200;
            response.setHeader(
              'Content-Type',
              contentTypes[extname(filePath)] ?? 'application/octet-stream',
            );
            response.setHeader('Cache-Control', 'no-cache');
            response.end(bytes);
          })
          .catch(() => next());
      });
    },
    async closeBundle() {
      await cp(
        resolve(replayPublicDir, 'fixtures'),
        resolve(import.meta.dirname, 'dist/fixtures'),
        {
          recursive: true,
          force: true,
          filter: (source) =>
            !source
              .split(sep)
              .some((part) =>
                ['nuke-demo-round-01', 'ancient-round-03', 'ancient-round-11-defuse'].includes(
                  part,
                ),
              ),
        },
      );
    },
  };
}

function appPublicAssets(directory: 'brand' | 'fixture-media') {
  const assetDirectory = resolve(replayPublicDir, directory);
  return {
    name: `mizar-${directory}-public-assets`,
    configureServer(server: import('vite').ViteDevServer) {
      server.middlewares.use(`/${directory}`, (request, response, next) => {
        const requestUrl = request.url;
        if (requestUrl === undefined) return next();
        let pathname: string;
        try {
          pathname = decodeURIComponent(new URL(requestUrl, 'http://localhost').pathname);
        } catch {
          return next();
        }
        const filePath = resolve(assetDirectory, `.${pathname}`);
        if (!filePath.startsWith(`${assetDirectory}${sep}`)) return next();
        void readFile(filePath)
          .then((bytes) => {
            const contentTypes: Record<string, string> = {
              '.svg': 'image/svg+xml',
              '.png': 'image/png',
              '.jpg': 'image/jpeg',
            };
            response.statusCode = 200;
            response.setHeader(
              'Content-Type',
              contentTypes[extname(filePath)] ?? 'application/octet-stream',
            );
            response.setHeader('Cache-Control', 'no-cache');
            response.end(bytes);
          })
          .catch(() => next());
      });
    },
    async closeBundle() {
      await cp(assetDirectory, resolve(import.meta.dirname, 'dist', directory), {
        recursive: true,
        force: true,
      });
    },
  };
}

function hostDiagnosticsDevelopmentApi() {
  return {
    name: 'mizar-host-diagnostics-development-api',
    configureServer(server: import('vite').ViteDevServer) {
      server.middlewares.use('/debug/hosts', (_request, response) => {
        void (async () => {
          try {
            const companionResponse = await fetch('http://127.0.0.1:3000/debug/hosts');
            if (companionResponse.ok) {
              const data = await companionResponse.text();
              response.statusCode = companionResponse.status;
              response.setHeader('Content-Type', 'application/json; charset=utf-8');
              response.setHeader('Cache-Control', 'no-cache');
              response.end(data);
              return;
            }
          } catch {
            // Companion is not running (e.g. during standalone Vite acceptance tests)
          }
          response.statusCode = 200;
          response.setHeader('Content-Type', 'application/json; charset=utf-8');
          response.setHeader('Cache-Control', 'no-cache');
          response.end(
            JSON.stringify({
              active: {
                obs: 0,
                browser: 0,
                unknown: 0,
                byChannel: {},
                byHostChannel: { obs: {}, browser: {}, unknown: {} },
                obsVersions: [],
              },
              totals: {
                connected: 0,
                disconnected: 0,
                connectionLimitRejected: 0,
                slowConsumerTerminated: 0,
                snapshotOversize: 0,
                heartbeatTerminated: 0,
                sendFailed: 0,
              },
              recentEvents: [],
            }),
          );
        })();
      });
    },
  };
}

function productShellStylesheet() {
  const stylesheet = resolve(import.meta.dirname, 'src/product-shell.css');
  return {
    name: 'mizar-product-shell-stylesheet',
    configureServer(server: import('vite').ViteDevServer) {
      server.middlewares.use('/product-shell.css', (_request, response, next) => {
        void readFile(stylesheet)
          .then((bytes) => {
            response.statusCode = 200;
            response.setHeader('Content-Type', 'text/css; charset=utf-8');
            response.setHeader('Cache-Control', 'no-cache');
            response.end(bytes);
          })
          .catch(next);
      });
    },
    async closeBundle() {
      await cp(stylesheet, resolve(import.meta.dirname, 'dist/product-shell.css'), {
        force: true,
      });
    },
  };
}

export default defineConfig({
  plugins: [
    react(),
    replayPublicAssets(),
    appPublicAssets('brand'),
    appPublicAssets('fixture-media'),
    replayPrefixDevelopmentApi(),
    productShellStylesheet(),
    hostDiagnosticsDevelopmentApi(),
  ],
  publicDir: cs2AssetsPublicDir,
  resolve: {
    alias: {
      // The replay-prefix API is development-only and loads test support through Vite SSR.
      // Bind it to the current worktree source so seek cannot consume a stale testkit dist
      // or dependency-cache entry after fixture provenance/schema changes.
      '@mizar/testkit': resolve(repositoryRoot, 'packages/testkit/src/index.ts'),
    },
  },
  server: {
    proxy: {
      '/operator/local-': 'http://127.0.0.1:3000',
      '/operator/rivalhub/': 'http://127.0.0.1:3000',
      '/operator/obs/': 'http://127.0.0.1:3000',
      '/operator/program-scene': 'http://127.0.0.1:3000',
      '/operator/program-director': 'http://127.0.0.1:3000',
      '/operator/rivals-rehearsal/': 'http://127.0.0.1:3000',
      '/operator/production': 'http://127.0.0.1:3000',
      '/operator/desktop-overlay': 'http://127.0.0.1:3000',
      '/operator/hud-config': 'http://127.0.0.1:3000',
      '/operator/bp-local-save': 'http://127.0.0.1:3000',
      '/operator/bp-rivalhub': 'http://127.0.0.1:3000',
      '/operator/bp-command': 'http://127.0.0.1:3000',
      '/operator/bp-demo': 'http://127.0.0.1:3000',
      '/operator/series': 'http://127.0.0.1:3000',
      '/debug/runtime': 'http://127.0.0.1:3000',
      '/debug/support-bundle': 'http://127.0.0.1:3000',
      '/local/v1': {
        target: 'http://127.0.0.1:3000',
        ws: true,
      },
    },
  },
});
