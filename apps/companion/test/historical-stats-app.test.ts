import { expect, it } from 'vitest';
import { buildApp } from '../src/app.js';

it('registers the historical presentation endpoint on the real app', async () => {
  const app = buildApp();
  try {
    const response = await app.inject('/local/v1/broadcast-stats-presentation');
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toBeNull();
  } finally {
    await app.close();
  }
});
