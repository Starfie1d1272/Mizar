import { createHash } from 'node:crypto';
import { chmod, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { registerStaticHost } from '../../src/local-web/static-host.js';
import { buildApp } from '../../src/app.js';
import {
  createActivePolicyVerifier,
  createRuntimeVerifier,
} from '../../src/resource-store/runtime-adapter.js';
import { ResourceStore } from '../../src/resource-store/store.js';
import { ProgramSceneController } from '../../src/program-scenes/controller.js';
import { registerProductionRoutes } from '../../src/program-scenes/production.js';
import { createLocalWebOriginPolicy } from '../../src/local-web/origin-policy.js';
import type { ProjectionCoordinator } from '../../src/projections/projection-coordinator.js';
import type { BpSession } from '../../src/bp/controller.js';

it('opens one real Store, retains old Full URLs without a publisher pin, and releases its writer on App close', async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'mizar-app-resources-'));
  const webRoot = join(root, 'web');
  await mkdir(join(webRoot, 'fixtures/epl-inferno-video/replay'), { recursive: true });
  await writeFile(join(webRoot, 'index.html'), '<html>Full</html>');
  await writeFile(join(webRoot, 'fixtures/epl-inferno-video/replay/background.mp4'), '0123456789');
  const app = buildApp({ webRoot, resources: { root: join(root, 'assets') } });
  try {
    await app.ready();
    const store = app.getDecorator<() => ResourceStore>('getResourceStore')();
    expect(store).toBeInstanceOf(ResourceStore);
    expect((await app.inject('/local/v1/resources')).json()).toEqual({ resources: store.list() });
    const response = await app.inject({
      url: '/fixtures/epl-inferno-video/replay/background.mp4',
      headers: { range: 'bytes=2-5' },
    });
    expect(response.statusCode).toBe(206);
    expect(response.body).toBe('2345');
    await expect(
      store.installVerified('official:epl-default', () => Promise.resolve({})),
    ).rejects.toThrow('resource_policy_unavailable');
    expect((await app.inject('/fixtures/epl-inferno-video/replay/background.mp4')).body).toBe(
      '0123456789',
    );
  } finally {
    await app.close();
  }
  const reopened = await ResourceStore.open({
    root: join(root, 'assets'),
    verifyTrustedPack: createRuntimeVerifier(undefined),
  });
  await reopened.close();
  await rm(root, { recursive: true, force: true });
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

it('calls actual offline receipt cryptography and refuses qualification proof as publisher authorization without network', async () => {
  const encode = (value: Buffer) => value.toString('base64');
  const fixture = new URL(
    '../../../../packages/resource-pack-contract/test-fixtures/tuf/',
    import.meta.url,
  );
  const proof = await readFile(
    new URL('../fixtures/updates/distribution.attestation.json', import.meta.url),
  );
  const sha = 'e46dcf7ff5bf01703da2ee40491f503d1fc4d76b';
  const statement = {
    schemaVersion: 'mizar.resource-publication.v1',
    repository: 'Starfie1d1272/Mizar',
    packId: 'official:epl-default',
    packVersion: '1.0.0',
    sourceRef: 'refs/heads/main',
    sourceSha: sha,
    promotionSha: sha,
    contentKind: 'recorded-replay',
    compatibility: {
      resourceSchemaVersion: 1,
      minimumCoreVersion: '1.1.0',
      maximumCoreVersionExclusive: '2.0.0',
    },
    manifestSha256: 'a'.repeat(64),
    archive: {
      name: 'Mizar-official-epl-default-1.0.0.zip',
      format: 'zip',
      bytes: 100,
      sha256: 'b'.repeat(64),
    },
    sequence: 1,
    issuedAt: '2026-10-09T01:00:00Z',
    expiresAt: '2026-10-10T01:00:00Z',
  };
  const receipt = {
    schemaVersion: 'mizar.resource-receipt.v1',
    publicationBase64: encode(Buffer.from(JSON.stringify(statement))),
    manifestBase64: encode(Buffer.from('{}')),
    publicationBundleBase64: encode(proof),
    archiveBundleBase64: encode(proof),
    trust: {
      schemaVersion: 'mizar.sigstore-cache.v1',
      rootChain: [],
      targetsBase64: encode(await readFile(new URL('targets.json', fixture))),
      trustedRootBase64: encode(await readFile(new URL('trusted_root.json', fixture))),
    },
  };
  const network = vi.fn(() => {
    throw new Error('offline only');
  });
  vi.stubGlobal('fetch', network);
  try {
    const policy = {
      packVersion: '1.0.0',
      sourceSha: sha,
      promotionSha: sha,
      coreVersion: '1.1.0',
      minimumSequence: 99,
      now: 0,
    };
    const verify = createRuntimeVerifier(policy);
    await expect(
      createActivePolicyVerifier(policy)({ receipt, signal: new AbortController().signal }),
    ).rejects.toThrow(/certificate identity/);
    await expect(
      verify({
        packId: 'official:epl-default',
        directory: '',
        receipt,
        purpose: 'cache',
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/certificate identity/);
    expect(network).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
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
