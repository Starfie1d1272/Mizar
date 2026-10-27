import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { expect, it } from 'vitest';
import { registerStaticHost } from '../src/local-web/static-host.js';

it('serves the compact browser source from the production static host', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bp-compact-static-'));
  const app = Fastify();
  try {
    await writeFile(join(root, 'index.html'), '<html>fixture</html>');
    registerStaticHost(app, { webRoot: root });
    const response = await app.inject('/program/bp-compact');
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('<html>fixture</html>');
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
