import { dirname, join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { LocalWebOriginPolicy } from '../local-web/origin-policy.js';
import type { OutputService } from '../output/service.js';
import type { createProduction } from '../program-scenes/production.js';
import type { ProjectionCoordinator } from '../projections/projection-coordinator.js';
import type { ProgramRuntime } from '../runtime/program-runtime.js';
import type { OnlineManifestConfig } from './http-source.js';
import {
  MatchContextController,
  MatchManifestLkgStore,
  type MatchContextBinding,
} from './index.js';
import { registerLocalAssetRoutes } from './local-assets.js';
import { registerLocalMatchExitRoutes } from './local-match-exit.js';
import { registerLocalTournamentRoutes } from './local-tournament-routes.js';
import { LocalTournamentStore } from './local-tournament-store.js';
import { registerManagedSourceRoutes } from './managed-source.js';
import { registerOnlineManifestRoutes } from './online-routes.js';
import type { RivalHubConnection } from './rivalhub-connection.js';
import { registerRivalHubConnectionRoutes } from './rivalhub-routes.js';
import { registerMatchDocument } from './runtime-binding.js';

export function createMatchContext(
  path: string | undefined,
  binding: MatchContextBinding | undefined,
) {
  return path === undefined
    ? null
    : new MatchContextController({
        lkgStore: new MatchManifestLkgStore({ filePath: path }),
        ...(binding === undefined ? {} : { initialBinding: binding }),
      });
}

export function registerMatchStores(
  app: FastifyInstance,
  controller: MatchContextController | null,
  tournamentPath: string | undefined,
) {
  if (controller) registerMatchDocument(app, controller);
  return tournamentPath === undefined ? null : new LocalTournamentStore(tournamentPath);
}

export function registerMatchControl(
  app: FastifyInstance,
  options: {
    controller: MatchContextController | null;
    store: LocalTournamentStore | null;
    production: Pick<ReturnType<typeof createProduction>, 'isTrialPending' | 'sessionId' | 'get'>;
    runtime: ProgramRuntime;
    projections: ProjectionCoordinator;
    originPolicy: LocalWebOriginPolicy;
    controlToken: string | undefined;
    tournamentPath: string | undefined;
    onRuntimeCommit: NonNullable<
      Parameters<typeof registerManagedSourceRoutes>[1]['onRuntimeCommit']
    >;
  },
) {
  const {
    controller: matchContextController,
    store: localTournamentStore,
    production,
    runtime: programRuntime,
    projections: projectionCoordinator,
    originPolicy,
  } = options;
  const localMatchExit =
    matchContextController === null
      ? undefined
      : registerLocalMatchExitRoutes(app, {
          controlToken: options.controlToken,
          loopback: originPolicy.mode === 'loopback',
          controller: matchContextController,
          runtime: programRuntime,
          eligibleSession: () =>
            !production.isTrialPending() && !matchContextController.isTemporary(),
          isPreparation: () => production.get().mode === 'preparation',
          productionSession: production.sessionId,
        });
  const managedSource = registerManagedSourceRoutes(app, {
    controlToken: options.controlToken,
    loopback: originPolicy.mode === 'loopback',
    controller: matchContextController,
    runtime: programRuntime,
    productionSession: production.sessionId,
    onRuntimeCommit: options.onRuntimeCommit,
  });
  if (localTournamentStore !== null && matchContextController !== null) {
    registerLocalTournamentRoutes(app, {
      store: localTournamentStore,
      projections: projectionCoordinator,
      controller: matchContextController,
      canReleaseLocalSelection: () => localMatchExit?.canReleaseLocalSelection() ?? false,
      canConfirmLocalExit: () => localMatchExit?.canConfirmLocalExit() ?? false,
      originPolicy,
    });
    registerLocalAssetRoutes(app, {
      directory: join(dirname(options.tournamentPath!), 'local-assets'),
      originPolicy,
    });
  }
  return { localMatchExit, managedSource };
}

export function registerOnlineMatchControl(
  app: FastifyInstance,
  options: {
    controller: MatchContextController | null;
    connection: RivalHubConnection | undefined;
    config: OnlineManifestConfig | undefined;
    production: Pick<
      ReturnType<typeof createProduction>,
      'isTrialPending' | 'sessionAllowed' | 'get' | 'statsActive'
    >;
    runtime: Pick<ProgramRuntime, 'canUpdateSeriesPlan'>;
    outputService: Pick<
      OutputService,
      'current' | 'currentStatus' | 'retry' | 'isPersistenceConfirmed'
    >;
    originPolicy: LocalWebOriginPolicy;
  },
) {
  const {
    controller: matchContextController,
    production,
    runtime: programRuntime,
    outputService,
    originPolicy,
  } = options;
  registerOnlineManifestRoutes(app, {
    isConnected: () => options.connection?.view().paired === true,
    originPolicy,
    controller: matchContextController,
    ...(options.config === undefined ? {} : { config: options.config }),
  });
  if (options.connection)
    registerRivalHubConnectionRoutes(app, {
      connection: options.connection,
      canClaim: () =>
        !production.isTrialPending() &&
        production.sessionAllowed() &&
        production.get().mode === 'live',
      canUpdatePlan: () => !production.isTrialPending() && programRuntime.canUpdateSeriesPlan(),
      canFetchStats: () => production.statsActive(),
      controller: matchContextController,
      currentSnapshot: () => outputService.current(true),
      currentSnapshotStatus: () => outputService.currentStatus(true),
      retryOutputPersistence: async () => {
        await outputService.retry();
        return outputService.isPersistenceConfirmed();
      },
      originPolicy,
    });
}

export function productionSource(
  connection:
    | Pick<
        RivalHubConnection,
        'handoffForExit' | 'retryExitHandoffs' | 'release' | 'stats' | 'clearStats'
      >
    | undefined,
): NonNullable<Parameters<typeof createProduction>[0]['source']> {
  return {
    handoffForExit: async () => {
      await connection?.handoffForExit();
    },
    retryExitHandoffs: async () => {
      await connection?.retryExitHandoffs();
    },
    release: async () => {
      await connection?.release();
    },
    stats: (target) => connection?.stats(target),
    clearStats: () => connection?.clearStats(),
  };
}
