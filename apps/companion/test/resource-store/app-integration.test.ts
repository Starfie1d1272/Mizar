import { createHash } from 'node:crypto';
import { chmod, mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { registerStaticHost } from '../../src/local-web/static-host.js';
import { ResourceStore } from '../../src/resource-store/store.js';
import { ProgramSceneController } from '../../src/program-scenes/controller.js';
import { registerProductionRoutes } from '../../src/program-scenes/production.js';
import { createLocalWebOriginPolicy } from '../../src/local-web/origin-policy.js';
import type { ProjectionCoordinator } from '../../src/projections/projection-coordinator.js';
import type { BpSession } from '../../src/bp/controller.js';
import { buildApp } from '../../src/app.js';

it('preserves the original filesystem failure for required installer resources with logging disabled', async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'mizar-resource-failure-'));
  const blocked = join(root, 'not-a-directory');
  await writeFile(blocked, 'preserve-existing-file');
  const app = buildApp({ resources: { root: join(blocked, 'assets'), required: true } });
  try {
    const error = await app.ready().then(
      () => undefined,
      (failure: unknown) => failure,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('resource_store_open_failed');
    const cause = (error as Error).cause as NodeJS.ErrnoException;
    expect(cause.code).toBe('ENOTDIR');
    expect(cause.syscall).toBe('mkdir');
    const diagnostic = inspect(error, { depth: 8, customInspect: false, getters: false });
    expect(diagnostic).toContain('resource_store_open_failed');
    expect(diagnostic).toContain('ENOTDIR');
    expect(diagnostic).toContain('mkdir');
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('retains normal Companion fallback when the optional resource store cannot open', async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'mizar-resource-fallback-'));
  const blocked = join(root, 'not-a-directory');
  await writeFile(blocked, 'preserve-existing-file');
  const app = buildApp({ resources: { root: join(blocked, 'assets') } });
  try {
    await app.ready();
    expect(app.getDecorator<() => ResourceStore | undefined>('getResourceStore')()).toBeUndefined();
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('holds production, scene and Host-update exclusion for the entire asynchronous activation', async () => {
  const app = Fastify();
  let finishScene!: () => void;
  let sceneStarted!: () => void;
  const sceneGate = new Promise<void>((resolve) => {
    finishScene = resolve;
  });
  const scenePending = new Promise<void>((resolve) => {
    sceneStarted = resolve;
  });
  const scenes = new ProgramSceneController(
    {
      getCurrent: () => ({
        operator: { runtime: { telemetryFreshness: 'fresh' }, matchContext: {}, identity: {} },
        program: {},
      }),
      getBpAssessment: () => ({ readiness: 'missing' }),
    } as unknown as ProjectionCoordinator,
    {} as BpSession,
    async () => {
      sceneStarted();
      await sceneGate;
    },
  );
  const production = registerProductionRoutes(app, {
    scenes,
    hasContext: () => true,
    originPolicy: createLocalWebOriginPolicy({ host: '127.0.0.1' }),
    release: () => Promise.resolve(),
  });
  let release!: () => void;
  let notify!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    notify = resolve;
  });
  try {
    const activation = production.withResourceActivation(async () => {
      notify();
      await gate;
    });
    await started;
    expect(production.reserveUpdate()).toBe(false);
    // Host prepare failure/release clears its own flag while the resource commit is pending.
    production.releaseUpdate();
    scenes.setUpdatePending(false);
    expect(scenes.resumeAutomatic(scenes.get().revision)).toBe(false);
    scenes.forceScene('matchup');
    scenes.forceScene('gameplay');
    expect(scenes.get().active).toBe('waiting');
    expect((await scenes.select('gameplay', scenes.get().revision)).ok).toBe(false);
    const enter = await app.inject({
      method: 'POST',
      url: '/operator/production',
      headers: { origin: 'http://127.0.0.1:3000' },
      payload: { action: 'enter', expectedRevision: production.get().revision },
    });
    expect(enter.statusCode).toBe(409);
    expect(production.get().mode).toBe('preparation');
    release();
    expect(await activation).toBe(true);
    expect(scenes.get().active).toBe('gameplay');
    scenes.forceScene('waiting');
    expect(production.reserveUpdate()).toBe(true);
    production.releaseUpdate();
    const sceneChange = scenes.select('gameplay', scenes.get().revision);
    await scenePending;
    const midTransition = vi.fn(() => Promise.resolve());
    expect(await production.withResourceActivation(midTransition)).toBe(false);
    expect(midTransition).not.toHaveBeenCalled();
    finishScene();
    expect((await sceneChange).ok).toBe(true);
    await app.inject({
      method: 'POST',
      url: '/operator/production',
      headers: { origin: 'http://127.0.0.1:3000' },
      payload: { action: 'enter', expectedRevision: production.get().revision },
    });
    const commit = vi.fn(() => Promise.resolve());
    expect(await production.withResourceActivation(commit)).toBe(false);
    expect(commit).not.toHaveBeenCalled();
  } finally {
    release();
    finishScene();
    await app.close();
  }
});

it('serves active verified bytes at original URLs and never mixes missing or corrupt members with Full', async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'mizar-resource-http-'));
  const path = 'fixtures/epl-inferno-video/replay/background.mp4';
  const webRoot = join(root, 'web');
  await mkdir(join(webRoot, 'fixtures/epl-inferno-video/replay'), { recursive: true });
  await writeFile(join(webRoot, 'index.html'), '<html>Full</html>');
  await writeFile(join(webRoot, path), 'bundled-old-version');
  await writeFile(join(webRoot, 'fixtures/epl-inferno-video/replay/other.mp4'), 'bundled-only');
  // HTTP routing fixture only: actual signature rejection is tested separately above.
  const store = await ResourceStore.open({
    root: join(root, 'assets'),
    verifyTrustedPack: () =>
      Promise.resolve({
        packId: 'official:epl-default',
        packVersion: 'http-fixture',
        compatible: true,
        files: [
          { path, bytes: 10, sha256: createHash('sha256').update('0123456789').digest('hex') },
        ],
      }),
    activateWhenSafe: async (commit) => {
      await commit();
      return true;
    },
  });
  const app = Fastify();
  registerStaticHost(app, {
    webRoot,
    readResource: (name, range) => store.read('official:epl-default', name, range),
  });
  try {
    await store.installVerified('official:epl-default', async ({ directory }) => {
      await mkdir(join(directory, 'fixtures/epl-inferno-video/replay'), { recursive: true });
      await writeFile(join(directory, path), '0123456789');
      return {};
    });
    const range = await app.inject({ url: '/' + path, headers: { range: 'bytes=2-5' } });
    expect(range.statusCode).toBe(206);
    expect(range.body).toBe('2345');
    expect(range.headers['content-range']).toBe('bytes 2-5/10');
    const head = await app.inject({ method: 'HEAD', url: '/' + path });
    expect(head.headers['content-length']).toBe('10');
    expect(head.body).toBe('');
    expect((await app.inject('/fixtures/epl-inferno-video/replay/other.mp4')).statusCode).toBe(404);
    const cached = await store.resolveReadOnlyPath('official:epl-default', path);
    await chmod(cached, 0o600);
    await writeFile(cached, 'corruption');
    const damaged = await app.inject('/' + path);
    expect(damaged.statusCode).toBe(409);
    expect(damaged.body).not.toContain('bundled-old-version');
  } finally {
    await app.close();
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
