import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { registerStaticHost } from '../local-web/static-host.js';
import type { ResourceTrustPolicy } from '@mizar/resource-pack-contract/runtime';
import type { FastifyInstance } from 'fastify';
import type { LocalWebOriginPolicy } from '../local-web/origin-policy.js';
import type { ProductRuntime } from '../runtime/product-runtime.js';
import { diagnosticValue } from '../support/session-journal.js';
import { prepareCurrentResource } from './recovery.js';
import { registerResourceRoutes } from './routes.js';
import { createRuntimeVerifier, isOfficialWebResource, PACK_ID } from './runtime-adapter.js';
import { ResourceStore } from './store.js';

type StoreOptions = Parameters<typeof ResourceStore.open>[0];

export function registerResourceRuntime(
  app: FastifyInstance,
  options: {
    config: {
      root: string;
      required?: boolean;
      policy?: ResourceTrustPolicy;
      cacheHistory?: readonly ResourceTrustPolicy[];
    };
    product: ProductRuntime | undefined;
    originPolicy: () => LocalWebOriginPolicy;
    activateWhenSafe: NonNullable<StoreOptions['activateWhenSafe']>;
    references?: StoreOptions['references'];
  },
): () => ResourceStore | undefined {
  let resources: ResourceStore | undefined;
  app.decorate('getResourceStore', () => resources);
  registerResourceRoutes(
    app,
    () => resources,
    options.product?.appVersion
      ? {
          core: {
            appVersion: options.product.appVersion,
            gitSha: options.product.gitSha,
          },
          root: options.config.root,
          originPolicy: options.originPolicy,
        }
      : undefined,
  );
  app.addHook('onReady', async () => {
    try {
      resources = await ResourceStore.open({
        root: options.config.root,
        diagnostic: (packId, error) =>
          app.log.warn(
            {
              event: 'resource',
              stage: 'resource_cache_verify',
              result: 'failure',
              packId,
              diagnostic: { error: diagnosticValue(error) },
            },
            '官方素材缓存验证失败。',
          ),
        verifyTrustedPack: createRuntimeVerifier(
          options.config.policy,
          options.config.cacheHistory,
          options.product?.appVersion
            ? {
                appVersion: options.product.appVersion,
                gitSha: options.product.gitSha,
              }
            : undefined,
        ),
        activateWhenSafe: (commit) => options.activateWhenSafe(commit),
        ...(options.references ? { references: options.references } : {}),
      });
      if (options.product?.appVersion && !resources.getStatus(PACK_ID).activeVersion) {
        const bundleRoot = process.env.MIZAR_BUNDLE_ROOT;
        let isCore = options.config.required === true;
        if (!isCore && bundleRoot) {
          try {
            const mode = JSON.parse(
              readFileSync(join(bundleRoot, 'resources/web/dist/web-resource-mode.json'), 'utf8'),
            ) as { resourceMode?: unknown };
            isCore = mode.resourceMode === 'core';
          } catch {
            // ignore missing or unreadable mode file
          }
        }
        if (isCore) {
          void resources
            .repair(
              PACK_ID,
              prepareCurrentResource(
                { appVersion: options.product.appVersion, gitSha: options.product.gitSha },
                options.config.root,
              ),
            )
            .catch((error: unknown) => {
              app.log.warn(
                {
                  event: 'resource',
                  stage: 'resource_auto_prepare',
                  result: 'failure',
                  diagnostic: { error: diagnosticValue(error) },
                },
                '官方素材自动准备失败，可稍后在素材库重试。',
              );
            });
        }
      }
    } catch (error) {
      app.log.warn(
        {
          event: 'resource',
          stage: 'resource_store_open',
          result: 'failure',
          diagnostic: { error: diagnosticValue(error) },
        },
        '官方素材缓存不可用；保留原 Full 资源路径。',
      );
      if (options.config.required) {
        throw new Error('resource_store_open_failed', { cause: error });
      }
    }
  });
  app.addHook('onClose', async () => {
    await resources?.shutdown();
  });
  return () => resources;
}

export function registerCompanionStaticWeb(
  app: FastifyInstance,
  webRoot: string | undefined,
  qualificationMode: boolean,
  readResources: () => ResourceStore | undefined,
): void {
  registerStaticHost(app, {
    ...(webRoot === undefined ? {} : { webRoot }),
    qualificationMode,
    readResource: async (path, range, signal) => {
      const resources = readResources();
      if (!resources || !isOfficialWebResource(path) || !resources.getStatus(PACK_ID).activeVersion)
        return undefined;
      return resources.read(PACK_ID, path, range, signal);
    },
  });
}
