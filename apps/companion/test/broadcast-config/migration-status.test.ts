import { expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';

it('reports pending migration without exposing or changing legacy settings', async () => {
  const app = buildApp();
  try {
    const response = await app.inject('/local/v1/broadcast-config/migration');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ state: 'pending', reason: 'owner_unavailable' });
    const forbidden = await app.inject({
      url: '/local/v1/broadcast-config/migration',
      headers: { origin: 'https://foreign.test' },
    });
    expect(forbidden.statusCode).toBe(403);
  } finally {
    await app.close();
  }
});
