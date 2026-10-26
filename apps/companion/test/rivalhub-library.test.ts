import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { validateBroadcastManifest, validateBroadcastScheduleWindow } from '@mizar/rivalhub';
import { RivalHubLibrary } from '../src/match-context/rivalhub-library.js';
import { RivalHubConnection } from '../src/match-context/rivalhub-connection.js';

const roots: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function fixture(size = 30) {
  const root = await mkdtemp(join(tmpdir(), 'mizar-demand-'));
  roots.push(root);
  const read = async (name: string) =>
    JSON.parse(
      await readFile(
        new URL(`../../../packages/rivalhub/test/fixtures/${name}.json`, import.meta.url),
        'utf8',
      ),
    ) as unknown;
  const valid = validateBroadcastManifest(await read('broadcast-manifest-v1.valid'));
  const window = validateBroadcastScheduleWindow(await read('broadcast-schedule-window-v1.valid'));
  if (!valid.ok || !window.ok) throw new Error('invalid fixture');
  const manifest = valid.value;
  const schedule = {
    ...window.value,
    matches: Array.from({ length: size }, (_, i) => ({
      ...window.value.matches[0]!,
      matchId: i === 0 ? manifest.match.matchId : `match-${i}`,
      scheduledAt: null,
    })),
  };
  return { root, manifest, schedule, id: manifest.match.matchId };
}
async function settled(library: RivalHubLibrary) {
  let value = await library.view();
  await vi.waitFor(async () => {
    value = await library.view();
    expect(value.library.refreshing).toBe(false);
  });
  return value;
}

it.each([30, 300])(
  'reads no manifests for an idle %i-match schedule over ten minutes; browsing reads only one',
  async (size) => {
    const f = await fixture(size);
    let clock = Date.parse('2026-09-16T12:00:00Z');
    const schedule = vi.fn(() => Promise.resolve(f.schedule));
    const read = vi.fn<(id: string, fresh: boolean) => Promise<unknown>>(() =>
      Promise.resolve(f.manifest),
    );
    const library = new RivalHubLibrary(
      join(f.root, 'library.json'),
      'competition-m2',
      schedule,
      read,
      () => clock,
    );
    for (let minute = 0; minute <= 10; minute++) {
      await settled(library);
      if (minute < 10) clock += 60_000;
    }
    expect(schedule).toHaveBeenCalledTimes(11);
    expect(read).toHaveBeenCalledTimes(0);
    expect((await library.view()).library.entries).toEqual({});
    for (let minute = 0; minute <= 10; minute++) {
      await library.detail(f.id, minute === 0);
      if (minute < 10) clock += 60_000;
    }
    expect(read).toHaveBeenCalledTimes(11);
    expect(read.mock.calls.every(([id]) => id === f.id)).toBe(true);
    console.info(
      JSON.stringify({
        size,
        minutes: 10,
        idleManifest: 0,
        browsedManifest: read.mock.calls.length,
        initial: 1,
        periodic: 10,
        retries: 0,
      }),
    );
  },
);

it('fetches corrections on reopen, persists only browsed details and distinguishes offline cache from missing details', async () => {
  const f = await fixture();
  let offline = false;
  let manifest = f.manifest;
  const schedule = () => {
    if (offline) return Promise.reject(new Error('offline'));
    return Promise.resolve(f.schedule);
  };
  const read = vi.fn(() => {
    if (offline) return Promise.reject(new Error('offline'));
    return Promise.resolve(manifest);
  });
  const path = join(f.root, 'library.json');
  const library = new RivalHubLibrary(path, 'competition-m2', schedule, read);
  await settled(library);
  await library.detail(f.id);
  manifest = {
    ...manifest,
    entrants: { ...manifest.entrants, a: { ...manifest.entrants.a, name: '管理员更正' } },
  };
  expect((await library.detail(f.id)).entry?.document.entrants.a.name).toBe('管理员更正');
  offline = true;
  const restored = new RivalHubLibrary(path, 'competition-m2', schedule, read);
  await settled(restored);
  expect((await restored.detail(f.id)).entry?.document.entrants.a.name).toBe('管理员更正');
  const missing = await restored.detail('match-1');
  expect(missing.entry).toBeNull();
  expect(missing.error).toContain('尚未缓存');
  await expect(new RivalHubLibrary(path, 'other', schedule, read).view()).rejects.toThrow();
});

async function connected(size = 30) {
  const f = await fixture(size);
  let manifest = f.manifest;
  const reads: string[] = [];
  let defer: ((response: Response) => void) | null = null;
  let delayed = false;
  const fetchImpl = vi.fn(async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.pathname.endsWith('/schedule')) return Response.json(f.schedule);
    if (url.pathname.endsWith('/match')) {
      const id = url.searchParams.get('matchId')!;
      reads.push(id);
      if (delayed)
        return new Promise<Response>((resolve) => {
          defer = resolve;
        });
      return Response.json({ ...manifest, match: { ...manifest.match, matchId: id } });
    }
    return Response.json({ ok: true });
  });
  const path = join(f.root, 'connection.json');
  const installation = {
    baseUrl: 'https://fixture.test',
    credential: 'fixture-only',
    installationId: 'fixture',
    competitionId: 'competition-m2',
    displayName: 'fixture',
  };
  await writeFile(path, JSON.stringify(installation));
  const connection = new RivalHubConnection(path, fetchImpl);
  await connection.load();
  return {
    ...f,
    connection,
    reads,
    path,
    installation,
    change: () => {
      manifest = {
        ...manifest,
        entrants: { ...manifest.entrants, a: { ...manifest.entrants.a, name: '最新更正' } },
      };
    },
    delay: () => {
      delayed = true;
    },
    resolve: () => {
      if (!defer) throw new Error('no pending read');
      delayed = false;
      defer(Response.json(manifest));
    },
  };
}

it.each([30, 300])(
  'keeps current production reads at 61 with %i scheduled matches and merges browsing ticks',
  async (size) => {
    const f = await connected(size);
    let clock = Date.parse('2026-09-16T12:00:00Z');
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    try {
      await f.connection.library();
      for (let tick = 0; tick <= 60; tick++) {
        const current = f.connection.matchSource(f.id, tick === 0).load();
        const browsing =
          tick % 6 === 0 ? f.connection.libraryDetail(f.id, tick === 0) : Promise.resolve();
        await Promise.all([current, browsing]);
        clock += 10_000;
      }
      expect(f.reads).toHaveLength(61);
      expect(new Set(f.reads)).toEqual(new Set([f.id]));
      f.change();
      const result = await f.connection.matchSource(f.id).load();
      expect(result).toMatchObject({ entrants: { a: { name: '最新更正' } } });
      expect(f.reads).toHaveLength(62); // Explicit fresh is a separate denominator.
      console.info(
        JSON.stringify({
          size,
          minutes: 10,
          currentAndBrowsingManifest: 61,
          initial: 1,
          periodic: 60,
          explicitFresh: 1,
          retries: 0,
        }),
      );
    } finally {
      vi.restoreAllMocks();
    }
  },
);

it('shares validated entities, rejects old-scope replies and never carries tags into reauthorization', async () => {
  const f = await connected();
  f.delay();
  const first = f.connection.matchSource(f.id).load();
  const second = f.connection.matchSource(f.id).load();
  expect(f.reads).toHaveLength(1);
  f.resolve();
  const [a, b] = await Promise.all([first, second]);
  expect(a).toEqual(b);
  expect(a).not.toBe(b);
  f.delay();
  const old = f.connection.matchSource(f.id);
  const late = old.load();
  const rejected = expect(late).rejects.toThrow('连接已变化');
  await writeFile(f.path, JSON.stringify({ ...f.installation, credential: 'new-fixture-only' }));
  await f.connection.load();
  f.resolve();
  await rejected;
  await expect(old.load()).rejects.toThrow('连接已变化');
  await expect(f.connection.matchSource('match-1').load()).resolves.toMatchObject({
    match: { matchId: 'match-1' },
  });
  await f.connection.disconnect();
  expect(() => f.connection.matchSource(f.id)).toThrow('请先连接');
});

it('keeps optional viewer identity in the operator schedule and updates renamed/removed assignments without manifest reads', async () => {
  const f = await fixture();
  const path = join(f.root, 'identity.json');
  await writeFile(
    path,
    JSON.stringify({
      baseUrl: 'https://fixture.test',
      credential: 'fixture-only',
      installationId: 'fixture',
      competitionId: 'competition-m2',
      displayName: '代授权设备',
    }),
  );
  let schedule: unknown = {
    ...f.schedule,
    viewer: { userId: 'user-a', displayName: '同名' },
    matches: f.schedule.matches.map((row) => ({ ...row, assignedToViewer: row.matchId === f.id })),
  };
  const fetchImpl = vi.fn(() => Promise.resolve(Response.json(schedule)));
  const connection = new RivalHubConnection(path, fetchImpl);
  await connection.load();
  expect(connection.view().authorizedUser).toBeNull();
  const first = await connection.schedule(f.schedule.from, f.schedule.to);
  expect(first.viewer).toEqual({ userId: 'user-a', displayName: '同名' });
  expect(first.matches.find((row) => row.matchId === f.id)?.assignedToViewer).toBe(true);
  schedule = {
    ...f.schedule,
    viewer: { userId: 'user-b', displayName: '同名' },
    matches: f.schedule.matches.map((row) => ({ ...row, assignedToViewer: false })),
  };
  await connection.schedule(f.schedule.from, f.schedule.to);
  expect(connection.view().authorizedUser?.userId).toBe('user-b');
  schedule = {
    ...f.schedule,
    viewer: { userId: 'user-b', displayName: '新昵称' },
    matches: f.schedule.matches.map((row) => ({ ...row, assignedToViewer: false })),
  };
  const renamed = await connection.schedule(f.schedule.from, f.schedule.to);
  expect(renamed.viewer?.displayName).toBe('新昵称');
  expect(renamed.matches[0]?.assignedToViewer).toBe(false);
  const restored = new RivalHubConnection(path, fetchImpl);
  await restored.load();
  expect(restored.view().authorizedUser).toEqual({ userId: 'user-b', displayName: '新昵称' });
  schedule = f.schedule; // Old server: absence stays unknown, never false by default.
  const legacy = await connection.schedule(f.schedule.from, f.schedule.to);
  expect(legacy.viewer).toBeUndefined();
  expect(legacy.matches[0]?.assignedToViewer).toBeUndefined();
  expect(connection.view().authorizedUser).toBeNull();
  expect(JSON.stringify(connection.getSchedule())).not.toContain('viewer');
  expect(JSON.stringify(connection.getSchedule())).not.toContain('assignedToViewer');
});

it('uses the registered ten-second production and minute schedule timers without background details', async () => {
  const { default: Fastify } = await import('fastify');
  const { registerRivalHubConnectionRoutes } =
    await import('../src/match-context/rivalhub-routes.js');
  const { MatchContextController, MatchManifestLkgStore } =
    await import('../src/match-context/index.js');
  const f = await connected(300);
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  vi.setSystemTime(new Date('2026-09-16T12:00:00Z'));
  const controller = new MatchContextController({
    lkgStore: new MatchManifestLkgStore({ filePath: join(f.root, 'active-lkg.json') }),
  });
  const app = Fastify();
  registerRivalHubConnectionRoutes(app, {
    connection: f.connection,
    controller,
    currentSnapshot: () => null,
    originPolicy: {
      mode: 'loopback',
      bindHost: '127.0.0.1',
      allowedOrigins: ['http://127.0.0.1:3000'],
    },
  });
  try {
    await app.ready();
    await f.connection.library();
    for (let minute = 0; minute < 10; minute++) await vi.advanceTimersByTimeAsync(60_000);
    expect(f.reads).toHaveLength(0);
    // Initial activation is counted separately from sixty ordinary timer ticks.
    expect((await controller.selectMatch(f.id, f.connection.matchSource(f.id))).ok).toBe(true);
    let checked: string | null = null;
    for (let tick = 1; tick <= 60; tick++) {
      await vi.advanceTimersByTimeAsync(10_000);
      const { setTimeout: wait } = await import('node:timers/promises');
      let next: string | null = checked;
      for (let attempt = 0; attempt < 1000 && next === checked; attempt++) {
        next = (await app.inject('/local/v1/rivalhub-connection')).json<{
          lastRefreshAt: string | null;
        }>().lastRefreshAt;
        if (next === checked) await wait(1);
      }
      expect(next).not.toBe(checked);
      checked = next;
      if (tick % 6 === 0) await f.connection.libraryDetail(f.id, false);
    }
    expect(f.reads).toHaveLength(61);
    expect(controller.getActiveBinding()?.origin).toBe('online');
  } finally {
    await app.close();
  }
});

it('keeps full provider lists at 255/256/257/300, clears older adjacent schedules on overflow and recovers', async () => {
  const f = await fixture(300);
  const path = join(f.root, 'boundary.json');
  await writeFile(
    path,
    JSON.stringify({
      baseUrl: 'https://fixture.test',
      credential: 'fixture-only',
      installationId: 'fixture',
      competitionId: 'competition-m2',
      displayName: 'fixture',
    }),
  );
  let size = 255;
  const connection = new RivalHubConnection(
    path,
    vi.fn((input) => {
      const url = String(input);
      return Promise.resolve(
        url.includes('/match?')
          ? Response.json(f.manifest)
          : Response.json({ ...f.schedule, matches: f.schedule.matches.slice(0, size) }),
      );
    }),
  );
  await connection.load();
  for (const n of [255, 256, 257, 300, 256]) {
    size = n;
    const schedule = await connection.schedule(f.schedule.from, f.schedule.to);
    expect(schedule.matches).toHaveLength(n);
    if (n > 256) {
      expect(connection.getSchedule()).toBeNull();
      expect(connection.view().scheduleWarning).toContain('相邻比赛推荐暂不可用');
      expect(await connection.matchSource(f.id).load()).toMatchObject({ match: { matchId: f.id } });
    } else {
      expect(connection.getSchedule()?.matches).toHaveLength(n);
      expect(connection.view().scheduleWarning).toBeNull();
    }
  }
});

it('bounds rapid different-match reads at three, releases failed slots, aborts old scopes and recovers current production', async () => {
  const { MatchContextController, MatchManifestLkgStore } =
    await import('../src/match-context/index.js');
  const f = await fixture();
  const path = join(f.root, 'bounded.json');
  const installation = {
    baseUrl: 'https://fixture.test',
    credential: 'fixture-only',
    installationId: 'fixture',
    competitionId: 'competition-m2',
    displayName: 'fixture',
  };
  await writeFile(path, JSON.stringify(installation));
  const pending = new Map<string, { resolve: (response: Response) => void; signal: AbortSignal }>();
  let calls = 0;
  const fetchImpl = vi.fn<typeof fetch>((input, init) => {
    const id = new URL(input instanceof Request ? input.url : input.toString()).searchParams.get(
      'matchId',
    )!;
    calls++;
    return new Promise<Response>((resolve, reject) => {
      const signal = init!.signal!;
      pending.set(id, { resolve, signal });
      signal.addEventListener(
        'abort',
        () => reject(new DOMException('fixture scope cancelled', 'AbortError')),
        { once: true },
      );
    });
  });
  const connection = new RivalHubConnection(path, fetchImpl);
  await connection.load();
  const controller = new MatchContextController({
    lkgStore: new MatchManifestLkgStore({ filePath: join(f.root, 'bounded-lkg.json') }),
  });
  expect(
    (
      await controller.selectMatch(f.id, {
        kind: 'online',
        load: () => Promise.resolve(f.manifest),
      })
    ).ok,
  ).toBe(true);
  const reads = ['match-1', 'match-2', 'match-3'].map((id) => connection.matchSource(id).load());
  const finished = Promise.allSettled(reads);
  const same = connection.matchSource('match-2').load();
  const sameFinished = Promise.allSettled([same]);
  expect(calls).toBe(3);
  await expect(connection.matchSource('match-4').load()).rejects.toMatchObject({
    code: 'unavailable',
  });
  await controller.refreshOnlineMatch(connection.matchSource(f.id));
  expect(controller.getActiveBinding()?.context.matchId).toBe(f.id);
  expect(calls).toBe(3);
  pending.get('match-1')!.resolve(new Response(null, { status: 404 }));
  await expect(reads[0]).rejects.toMatchObject({ code: 'not_found' });
  const recovering = controller.refreshOnlineMatch(connection.matchSource(f.id));
  pending.get(f.id)!.resolve(Response.json(f.manifest));
  expect((await recovering).ok).toBe(true);
  expect(controller.getActiveBinding()?.freshness).toBe('fresh');
  await writeFile(path, JSON.stringify({ ...installation, credential: 'new-fixture-only' }));
  await connection.load();
  expect(pending.get('match-2')!.signal.aborted).toBe(true);
  expect(pending.get('match-3')!.signal.aborted).toBe(true);
  expect((await finished).filter((result) => result.status === 'rejected')).toHaveLength(3);
  await sameFinished;
  const fresh = connection.matchSource(f.id).load();
  pending.get(f.id)!.resolve(Response.json(f.manifest));
  await expect(fresh).resolves.toMatchObject({ match: { matchId: f.id } });
});

it('restores the original installation-scoped browsing file after upgrade when the website is offline', async () => {
  const { createHash } = await import('node:crypto');
  const f = await fixture();
  const path = join(f.root, 'upgrade.json');
  const installation = {
    baseUrl: 'https://fixture.test',
    credential: 'fixture-only',
    installationId: 'fixture',
    competitionId: 'competition-m2',
    displayName: 'fixture',
  };
  await writeFile(path, JSON.stringify(installation));
  const scope = createHash('sha256')
    .update(
      JSON.stringify([
        installation.baseUrl,
        installation.competitionId,
        installation.installationId,
      ]),
    )
    .digest('hex');
  const cachePath = `${path}.${scope}.library.json`;
  await writeFile(
    cachePath,
    JSON.stringify({
      schedule: f.schedule,
      entries: {
        [f.id]: {
          etag: 'old-tag',
          checkedAt: '2026-09-16T12:00:00Z',
          updatedAt: '2026-09-16T12:00:00Z',
        },
      },
      syncedAt: '2026-09-16T12:00:00Z',
      manifests: { [f.id]: f.manifest },
    }),
  );
  const fetchImpl = vi.fn<typeof fetch>(() => Promise.reject(new TypeError('fixture offline')));
  const connection = new RivalHubConnection(path, fetchImpl);
  await connection.load();
  let view = await connection.library();
  await vi.waitFor(async () => {
    view = await connection.library();
    expect(view.library.refreshing).toBe(false);
  });
  expect(view.library.entries[f.id]?.document.matchId).toBe(f.id);
  expect(view.library.error).toContain('保留');
  const saved = JSON.parse(await readFile(cachePath, 'utf8')) as Record<string, unknown>;
  await writeFile(
    cachePath,
    JSON.stringify({
      ...saved,
      schedule: {
        ...f.schedule,
        viewer: { userId: 'previous-account', displayName: '旧授权昵称' },
        matches: f.schedule.matches.map((row) => ({ ...row, assignedToViewer: true })),
      },
    }),
  );
  await connection.load();
  const newScope = await connection.library();
  expect(newScope.viewer).toBeUndefined();
  expect(newScope.matches.every((row) => row.assignedToViewer === undefined)).toBe(true);
  expect(newScope.library.entries[f.id]?.document.matchId).toBe(f.id);
  expect(
    fetchImpl.mock.calls.every(([input]) =>
      (input instanceof Request ? input.url : input.toString()).includes('/schedule?'),
    ),
  ).toBe(true);
});

it('consumes real PostgreSQL/server new and legacy schedules without leaking operator identity into core', async () => {
  const { toScheduleWindowV1 } = await import('@mizar/rivalhub');
  const read = async (name: string) =>
    JSON.parse(
      await readFile(
        new URL(
          `../../../packages/rivalhub/test/fixtures/server-schedule-2026-10-26/${name}`,
          import.meta.url,
        ),
        'utf8',
      ),
    ) as unknown;
  const modern = validateBroadcastScheduleWindow(await read('schedule-new-http.json'));
  const legacy = validateBroadcastScheduleWindow(await read('schedule-old-shape.json'));
  const identity = (await read('poll-authorized-public-identity.json')) as {
    authorizedUser: { userId: string; displayName: string };
  };
  expect(modern.ok).toBe(true);
  expect(legacy.ok).toBe(true);
  if (!modern.ok || !legacy.ok) throw new Error('real server schedule rejected');
  expect(modern.value.viewer).toEqual(identity.authorizedUser);
  expect(modern.value.matches.map((row) => row.assignedToViewer)).toEqual([true, false, false]);
  expect(legacy.value.viewer).toBeUndefined();
  expect(legacy.value.matches.every((row) => row.assignedToViewer === undefined)).toBe(true);
  for (const schedule of [modern.value, legacy.value]) {
    const core = toScheduleWindowV1(schedule);
    expect(core.matches).toHaveLength(3);
    const publicFacts = JSON.stringify(core);
    expect(publicFacts).not.toContain('viewer');
    expect(publicFacts).not.toContain('assignedToViewer');
    expect(publicFacts).not.toContain(identity.authorizedUser.userId);
  }
});

it('loads an explicitly selected website match in one request while preserving stage-only callers', async () => {
  const { default: Fastify } = await import('fastify');
  const { registerRivalHubConnectionRoutes } =
    await import('../src/match-context/rivalhub-routes.js');
  const { MatchContextController, MatchManifestLkgStore } =
    await import('../src/match-context/index.js');
  const f = await connected(1);
  const controller = new MatchContextController({
    lkgStore: new MatchManifestLkgStore({ filePath: join(f.root, 'selected-lkg.json') }),
  });
  const app = Fastify();
  registerRivalHubConnectionRoutes(app, {
    connection: f.connection,
    controller,
    currentSnapshot: () => null,
    originPolicy: {
      mode: 'loopback',
      bindHost: '127.0.0.1',
      allowedOrigins: ['http://127.0.0.1:3000'],
    },
  });
  try {
    const staged = await app.inject({
      method: 'POST',
      url: '/operator/rivalhub/select',
      headers: { origin: 'http://127.0.0.1:3000' },
      payload: { matchId: f.id },
    });
    expect(staged.json()).toEqual({ pending: true });
    expect(controller.getActiveBinding()).toBeUndefined();
    const loaded = await app.inject({
      method: 'POST',
      url: '/operator/rivalhub/select',
      headers: { origin: 'http://127.0.0.1:3000' },
      payload: { matchId: f.id, activate: true },
    });
    expect(loaded.statusCode).toBe(200);
    expect(loaded.json()).toEqual({ loaded: true, matchId: f.id });
    expect(controller.getActiveBinding()?.context.matchId).toBe(f.id);
    expect(controller.getPendingOnlineCandidate()).toBeUndefined();
  } finally {
    await app.close();
  }
});
