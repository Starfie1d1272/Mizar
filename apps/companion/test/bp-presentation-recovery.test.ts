import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { buildApp } from '../src/app.js';

// Synthetic preference failures exercise the production startup and operator routes.
it('isolates damaged BP preferences and explicitly saves even the fallback mode', async () => {
  for (const content of ['{"mode":', '{"mode":"obsolete"}', '{"mode":"compact"}']) {
    const root = await mkdtemp(join(tmpdir(), 'mizar-bp-preference-'));
    const path = join(root, 'bp-presentation.json');
    const options = { obsConfigPath: join(root, 'obs.json') };
    const app = buildApp(options);
    const damaged = !content.includes('compact');
    try {
      await writeFile(path, content);
      await writeFile(join(root, 'unrelated.json'), '{"keep":true}');
      await app.ready();
      expect((await app.inject('/local/v1/production')).statusCode).toBe(200);
      const before = (await app.inject('/local/v1/bp-presentation')).json();
      expect(before.mode).toBe(damaged ? 'full' : 'compact');
      expect(Boolean(before.recovery)).toBe(damaged);
      expect(await readFile(path, 'utf8')).toBe(content);
      expect(await readdir(root)).not.toContain(expect.stringContaining('.bak'));
      const post = (expectedRevision: string) =>
        app.inject({
          method: 'POST',
          url: '/operator/bp-presentation',
          headers: { origin: 'http://127.0.0.1:3000' },
          payload: { mode: 'full', expectedRevision },
        });
      expect((await post('stale')).statusCode).toBe(409);
      expect(await readFile(path, 'utf8')).toBe(content);
      const saved = await post(before.revision);
      expect(saved.statusCode).toBe(200);
      expect(saved.json().recovery).toBeNull();
      expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ mode: 'full' });
      const backups = (await readdir(root)).filter((name) => name.endsWith('.bak'));
      expect(backups).toHaveLength(damaged ? 1 : 0);
      if (damaged) expect(await readFile(join(root, backups[0]!), 'utf8')).toBe(content);
      expect(await readFile(join(root, 'unrelated.json'), 'utf8')).toBe('{"keep":true}');
      await app.close();
      const restarted = buildApp(options);
      try {
        await restarted.ready();
        expect((await restarted.inject('/local/v1/bp-presentation')).json()).toMatchObject({
          mode: 'full',
          recovery: null,
        });
      } finally {
        await restarted.close();
      }
    } finally {
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  }
});

it('keeps read and save failures recoverable until storage is repaired', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mizar-bp-storage-'));
  const path = join(root, 'bp-presentation.json');
  await mkdir(path); // Deterministic read/write failure, including privileged CI runners.
  const app = buildApp({ obsConfigPath: join(root, 'obs.json') });
  try {
    await app.ready();
    expect((await app.inject('/local/v1/production')).statusCode).toBe(200);
    const before = (await app.inject('/local/v1/bp-presentation')).json();
    expect(before.recovery.reason).toBe('EISDIR');
    const save = () =>
      app.inject({
        method: 'POST',
        url: '/operator/bp-presentation',
        headers: { origin: 'http://127.0.0.1:3000' },
        payload: { mode: 'full', expectedRevision: before.revision },
      });
    expect((await save()).statusCode).toBe(503);
    expect((await app.inject('/local/v1/bp-presentation')).json()).toEqual(before);
    expect((await app.inject('/local/v1/production')).statusCode).toBe(200);
    await rm(path, { recursive: true });
    expect((await save()).statusCode).toBe(200);
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ mode: 'full' });
    expect((await app.inject('/local/v1/bp-presentation')).json().recovery).toBeNull();
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
