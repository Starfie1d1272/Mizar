import { afterEach, describe, expect, it, vi } from 'vitest';
import { setImmediate } from 'node:timers/promises';
import type { FastifyInstance } from 'fastify';
import type { RivalHubConnection } from '../src/match-context/rivalhub-connection.js';
import { buildApp } from '../src/app.js';

describe('portable runtime management', () => {
  let app: FastifyInstance;
  afterEach(async () => app?.close());
  it('exposes artifact identity without its shutdown capability', async () => {
    const stop = vi.fn();
    app = buildApp({
      productRuntime: {
        artifactSha256: 'a'.repeat(64),
        gitSha: 'b'.repeat(40),
        instanceId: 'instance',
        controlToken: 'secret',
        stop,
      },
    });
    const health = await app.inject('/health');
    expect(health.json<{ product: unknown }>().product).toEqual({
      repository: 'Starfie1d1272/Mizar',
      artifactSha256: 'a'.repeat(64),
      gitSha: 'b'.repeat(40),
      instanceId: 'instance',
      mode: 'product',
    });
    expect(health.body).not.toContain('secret');
    for (const headers of [
      {},
      { 'x-runtime-token': 'wrong' },
      { 'x-runtime-token': 'secret', origin: 'http://127.0.0.1:3000' },
    ]) {
      expect(
        (await app.inject({ method: 'POST', url: '/operator/runtime/stop', headers })).statusCode,
      ).toBe(403);
    }
    expect(stop).not.toHaveBeenCalled();
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/operator/runtime/stop',
          headers: { 'x-runtime-token': 'secret' },
        })
      ).statusCode,
    ).toBe(202);
    await setImmediate();
    expect(stop).toHaveBeenCalledOnce();
  });
  it('verified CLI stop waits for source release and refuses to stop on failure', async () => {
    const calls: string[] = [];
    const release = vi.fn((): Promise<void> => {
      calls.push('release');
      return Promise.reject(new Error('release failed'));
    });
    const stop = vi.fn(() => {
      calls.push('stop');
    });
    app = buildApp({
      rivalhubConnection: {
        release,
        view: () => ({ paired: false }),
        reliableAuthorityScope: () => undefined,
      } as unknown as RivalHubConnection,
      productRuntime: {
        artifactSha256: 'a'.repeat(64),
        gitSha: 'b'.repeat(40),
        instanceId: 'instance',
        controlToken: 'secret',
        stop,
      },
    });
    const send = () =>
      app.inject({
        method: 'POST',
        url: '/operator/runtime/stop',
        headers: { 'x-runtime-token': 'secret' },
      });
    expect((await send()).statusCode).toBe(409);
    await setImmediate();
    expect(stop).not.toHaveBeenCalled();
    release.mockImplementationOnce(() => {
      calls.push('release');
      return Promise.resolve();
    });
    expect((await send()).statusCode).toBe(202);
    await setImmediate();
    expect(calls).toEqual(['release', 'release', 'stop']);
    expect((await app.inject('/local/v1/production')).json()).toMatchObject({
      mode: 'preparation',
      canEnter: false,
    });
  });
  it('does not register runtime management in ordinary development or qualification', async () => {
    app = buildApp();
    expect((await app.inject('/health')).json()).not.toHaveProperty('product');
    expect((await app.inject({ method: 'POST', url: '/operator/runtime/stop' })).statusCode).toBe(
      404,
    );
  });
});
