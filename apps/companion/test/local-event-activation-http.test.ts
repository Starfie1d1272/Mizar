import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { afterEach, expect, it, vi } from 'vitest';
import { MatchContextController } from '../src/match-context/controller.js';
import { MatchManifestLkgStore } from '../src/match-context/lkg-store.js';
import { LocalTournamentStore } from '../src/match-context/local-tournament-store.js';
import { registerLocalTournamentRoutes } from '../src/match-context/local-tournament-routes.js';
import { ProgramRuntime } from '../src/runtime/program-runtime.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(cleanup.splice(0).map((close) => close()));
});
function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'mizar-local-event-http-'));
  const store = new LocalTournamentStore(join(directory, 'local.json'));
  const runtime = new ProgramRuntime('synthetic-event-activation');
  const controller = new MatchContextController({
    lkgStore: new MatchManifestLkgStore({ filePath: join(directory, 'lkg.json') }),
    onBindingChanged: (binding) => {
      runtime.bindContext(binding?.context, binding?.origin);
    },
  });
  const app = Fastify();
  cleanup.push(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });
  registerLocalTournamentRoutes(app, {
    store,
    controller,
    originPolicy: { mode: 'loopback', bindHost: '127.0.0.1', allowedOrigins: [] },
    canReleaseLocalSelection: () => false,
    canConfirmLocalExit: () => false,
    withLocalSelectionRelease: async () => false,
  });
  await app.ready();
  const post = (url: string, payload: Record<string, unknown>) =>
    app
      .inject({ method: 'POST', url, payload, headers: { origin: 'http://127.0.0.1:3000' } })
      .then((response) => response);
  const create = async (name: string) => {
    const response = await post('/operator/local-match/create', {
      teamA: `${name} A`,
      teamB: `${name} B`,
      format: 'bo3',
      eventName: name,
    });
    expect(response.statusCode).toBe(200);
    return store.getSnapshot().matches.find((match) => match.matchId === response.json().matchId)!;
  };
  const a = await create('Event A');
  const b = await create('Event B');
  const event = store
    .getSnapshot()
    .events.find((item) => item.eventId === a.competition!.competitionId)!;
  const edit = {
    ...event,
    name: 'Updated A',
    logoUrl: '/local/assets/a.png',
    themeColor: 'var(--color-accent)',
    mapPool: ['de_dust2', 'de_nuke'],
  };
  const assertUpdated = () => {
    const stored = store.getSnapshot().matches.find((match) => match.matchId === a.matchId)!;
    expect(stored.competition).toMatchObject({
      name: edit.name,
      logoUrl: edit.logoUrl,
      themeColor: edit.themeColor,
    });
    expect(controller.getActiveBinding()?.context).toEqual(stored);
    expect(runtime.getSnapshot().seriesProgress?.matchId).toBe(a.matchId);
    expect(runtime.getSnapshot().seriesProgress?.sourcePlan.allowedMaps).toEqual(edit.mapPool);
  };
  return { store, controller, runtime, post, a, b, event, edit, assertUpdated };
}

it.each(['enter', 'leave'] as const)(
  'uses the selection that runs ahead of an event edit: %s',
  async (direction) => {
    const r = await setup();
    if (direction === 'leave') {
      expect(
        (await r.post('/operator/local-match/select', { matchId: r.a.matchId })).statusCode,
      ).toBe(200);
    }
    const entered = signal(),
      release = signal(),
      queued = signal();
    const select = r.store.selectMatch.bind(r.store);
    vi.spyOn(r.store, 'selectMatch').mockImplementationOnce(async (...args) => {
      entered.resolve();
      await release.promise;
      return select(...args);
    });
    const save = r.controller.saveLocalEvent.bind(r.controller);
    vi.spyOn(r.controller, 'saveLocalEvent').mockImplementationOnce((...args) => {
      const result = save(...args);
      queued.resolve();
      return result;
    });
    const selecting = r.post('/operator/local-match/select', {
      matchId: direction === 'enter' ? r.a.matchId : r.b.matchId,
    });
    await entered.promise;
    const editing = r.post('/operator/local-event/save', r.edit);
    await queued.promise;
    release.resolve();
    expect((await selecting).statusCode).toBe(200);
    expect((await editing).statusCode).toBe(200);
    if (direction === 'enter') r.assertUpdated();
    else {
      expect(
        r.store.getSnapshot().matches.find((match) => match.matchId === r.a.matchId)?.competition
          ?.name,
      ).toBe(r.edit.name);
      expect(r.controller.getActiveBinding()?.context).toEqual(r.b);
      expect(r.runtime.getSnapshot().seriesProgress?.matchId).toBe(r.b.matchId);
    }
  },
);

it('selects the latest stored document when the event edit runs first', async () => {
  const r = await setup();
  const entered = signal(),
    release = signal(),
    queued = signal();
  const save = r.store.saveEvent.bind(r.store);
  vi.spyOn(r.store, 'saveEvent').mockImplementationOnce(async (...args) => {
    entered.resolve();
    await release.promise;
    return save(...args);
  });
  const select = r.controller.selectLocalTournamentMatch.bind(r.controller);
  vi.spyOn(r.controller, 'selectLocalTournamentMatch').mockImplementationOnce((...args) => {
    const result = select(...args);
    queued.resolve();
    return result;
  });
  const editing = r.post('/operator/local-event/save', r.edit);
  await entered.promise;
  const selecting = r.post('/operator/local-match/select', { matchId: r.a.matchId });
  await queued.promise;
  release.resolve();
  expect((await editing).statusCode).toBe(200);
  expect((await selecting).statusCode).toBe(200);
  r.assertUpdated();
});

it.each(['selection', 'binding'] as const)(
  'rejects a running event edit superseded by a newer %s',
  async (change) => {
    const r = await setup();
    expect(
      (await r.post('/operator/local-match/select', { matchId: r.a.matchId })).statusCode,
    ).toBe(200);
    const entered = signal(),
      release = signal(),
      queued = signal();
    const save = r.store.saveEvent.bind(r.store);
    vi.spyOn(r.store, 'saveEvent').mockImplementationOnce(async (...args) => {
      entered.resolve();
      await release.promise;
      return save(...args);
    });
    const editing = r.post('/operator/local-event/save', r.edit);
    await entered.promise;
    let selecting;
    if (change === 'selection') {
      const select = r.controller.selectLocalTournamentMatch.bind(r.controller);
      vi.spyOn(r.controller, 'selectLocalTournamentMatch').mockImplementationOnce((...args) => {
        const result = select(...args);
        queued.resolve();
        return result;
      });
      selecting = r.post('/operator/local-match/select', { matchId: r.b.matchId });
      await queued.promise;
    } else {
      r.controller.activateLocalDocument({ ...r.a, stageLabel: 'New binding' });
    }
    release.resolve();
    expect((await editing).statusCode).toBe(409);
    if (selecting) expect((await selecting).statusCode).toBe(200);
    expect(r.store.getSnapshot().events.find((event) => event.eventId === r.event.eventId)).toEqual(
      r.event,
    );
    expect(r.controller.getActiveBinding()?.context.matchId).toBe(
      change === 'selection' ? r.b.matchId : r.a.matchId,
    );
    if (change === 'binding')
      expect(r.controller.getActiveBinding()?.context.stageLabel).toBe('New binding');
  },
);
