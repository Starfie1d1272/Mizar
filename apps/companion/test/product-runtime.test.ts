import { afterEach, describe, expect, it, vi } from 'vitest';
import { setImmediate } from 'node:timers/promises';
import type { FastifyInstance } from 'fastify';
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
  it('does not register runtime management in ordinary development or qualification', async () => {
    app = buildApp();
    expect((await app.inject('/health')).json()).not.toHaveProperty('product');
    expect((await app.inject({ method: 'POST', url: '/operator/runtime/stop' })).statusCode).toBe(
      404,
    );
  });
});
