import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import type {
  CstvParserSessionFactory,
  CstvParserSessionFactoryOptions,
  CstvSessionRunResult,
} from '@mizar/telemetry-cstv';

import { buildApp } from '../src/app.js';
import { createCstvSourceManagers } from '../src/telemetry/cstv-source-manager.js';

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('Companion CSTV debug projection', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    if (app) {
      await app.close();
      app = undefined;
    }
  });

  it('redacts source identity while exposing bounded role-local evidence', async () => {
    let options: CstvParserSessionFactoryOptions | undefined;
    let resolveRun: ((result: CstvSessionRunResult) => void) | undefined;
    const parserSessionFactory: CstvParserSessionFactory = (nextOptions) => {
      options = nextOptions;
      return {
        sync: null,
        tailTick: 42,
        start: () => {
          nextOptions.onSync({
            protocol: 5,
            tick: 10,
            ticksPerSecond: 64,
            fragment: 1,
            signupFragment: 1,
          });
          return Promise.resolve({ status: 'ready' as const });
        },
        run: () =>
          new Promise<CstvSessionRunResult>((resolve) => {
            resolveRun = resolve;
          }),
        stop: () => resolveRun?.({ status: 'cancelled' }),
      };
    };
    const cstvSources = createCstvSourceManagers({
      programUrl: 'https://example.test/program/',
      lookaheadUrl: 'https://example.test/lookahead/',
      parserSessionFactory,
      scheduler: {
        setTimeout: () => undefined,
        clearTimeout: () => {},
      },
    });
    app = buildApp({ cstvSources, gsiToken: 'gsi-secret' });

    cstvSources.program.start();
    await flush();
    options?.onEvent(
      'weapon_fire',
      {
        userid: 11,
        player: { steamId: '76561198012345678', name: 'Private Name', teamNumber: 3 },
        weapon: 'm4a1',
        silenced: false,
      },
      42,
    );
    options?.onDiagnostic({ code: 'normalization-failed', eventName: 'weapon_fire' });

    resolveRun?.({ status: 'timeout' });
    await flush();
    const gsiResponse = await app.inject({
      method: 'POST',
      url: '/gsi',
      headers: { 'content-type': 'application/json' },
      payload: {
        auth: { token: 'gsi-secret' },
        map: { name: 'de_mirage', phase: 'live' },
        round: { phase: 'live' },
      },
    });
    expect(gsiResponse.statusCode).toBe(204);

    const response = await app.inject({ method: 'GET', url: '/debug/runtime' });
    const body: unknown = response.json();
    const serialized = JSON.stringify(body) ?? '';
    expect(response.statusCode).toBe(200);
    expect(body).toMatchObject({
      cstvSources: {
        program: {
          state: 'reconnecting',
          generation: 0,
          lastEventSequence: 0,
          tailTick: 42,
        },
        lookahead: { state: 'stopped', generation: 0 },
      },
      recentGameEvents: { program: [{ kind: 'weapon-fire' }], lookahead: [] },
    });
    expect(serialized).toContain('normalization-failed');
    expect(serialized).not.toContain('76561198012345678');
    expect(serialized).not.toContain('Private Name');
    expect(serialized).not.toContain('sourceUserId":11');
  });
});
