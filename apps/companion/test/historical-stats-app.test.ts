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

it('serves the program statistics route over local HTTP on the assembled app', async () => {
  const app = buildApp();
  try {
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const response = await fetch(`${address}/local/v1/broadcast-stats-program`);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toBeNull();
  } finally {
    await app.close();
  }
});
