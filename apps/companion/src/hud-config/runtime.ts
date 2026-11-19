import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import { registerBroadcastMigrationStatus } from '../broadcast-config/migration-status.js';
import type { registerBroadcastOwners } from '../broadcast-config/live-owners.js';
import type { LocalWebOriginPolicy } from '../local-web/origin-policy.js';
import { defaultWebRoot } from '../local-web/static-host.js';
import { diagnosticValue } from '../support/session-journal.js';
import { registerHudConfigRoutes } from './controller.js';
import { HudConfigStore } from './store.js';

export function createHudConfigRuntime(
  log: FastifyBaseLogger,
  store: HudConfigStore | undefined,
  path: string | undefined,
): HudConfigStore {
  return (
    store ??
    new HudConfigStore({
      ...(path === undefined ? {} : { filePath: path }),
      onDiagnostic: (code, error) =>
        log.warn({ code, error: diagnosticValue(error), path: path }, 'Companion HUD 配置诊断'),
    })
  );
}

export function registerHudRuntimeRoutes(
  app: FastifyInstance,
  options: {
    originPolicy: LocalWebOriginPolicy;
    hudConfigStore: HudConfigStore;
    hasBroadcastConfig: boolean;
    webRoot: string | undefined;
    readBroadcast: () => ReturnType<typeof registerBroadcastOwners>['broadcast'] | undefined;
  },
): void {
  const { originPolicy, hudConfigStore } = options;
  registerBroadcastMigrationStatus(
    app,
    originPolicy,
    () => options.readBroadcast()?.status ?? { state: 'pending', reason: 'owner_unavailable' },
  );
  if (!options.hasBroadcastConfig)
    app.get('/local/v1/broadcast-display-config', (_request, reply) =>
      reply.code(503).send({ error: 'broadcast_config_unavailable' }),
    );
  registerHudConfigRoutes(app, {
    store: hudConfigStore,
    getBroadcastDocument: () => options.readBroadcast()?.appliedDocument(),
    webRoot: options.webRoot ?? defaultWebRoot(),
    waitForBroadcast: async () => {
      await options.readBroadcast()?.waitForApply();
      if (options.hasBroadcastConfig && !options.readBroadcast()?.ready)
        throw new Error('broadcast_config_unavailable');
    },
    originPolicy,
  });
}
