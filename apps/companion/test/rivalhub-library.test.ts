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
