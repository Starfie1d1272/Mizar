import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import type { BroadcastManifest, BroadcastScheduleWindowV1 } from '@mizar/rivalhub';
import { afterEach, describe, expect, it } from 'vitest';

import { MATCH_CONTEXT_CACHE_VERSION } from '../src/match-context/lkg-store.js';
import {
  createFixtureManifestSource,
  MatchContextController,
  MatchManifestLkgStore,
  ScheduleWindowController,
  ScheduleWindowLkgStore,
  SourceLoadError,
} from '../src/match-context/index.js';
import type { ScheduleWindowRequest } from '../src/match-context/index.js';
import { SCHEDULE_WINDOW_CACHE_VERSION } from '../src/match-context/schedule-window-store.js';
import type { DurableJsonCommitPoint } from '../src/match-context/durable-json.js';

const fixtureRoot = resolve(process.cwd(), 'packages/rivalhub/test/fixtures');
const temporaryRoots: string[] = [];

async function readFixture<T>(fileName: string): Promise<T> {
  return JSON.parse(await readFile(join(fixtureRoot, fileName), 'utf8')) as T;
}

async function temporaryDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'mizar-m2-'));
  temporaryRoots.push(root);
  return root;
}

function source(kind: 'online' | 'fixture', value: unknown) {
  return { kind, load: () => Promise.resolve(value) } as const;
}

function scheduleRequest(schedule: BroadcastScheduleWindowV1): ScheduleWindowRequest {
  return {
    competitionId: schedule.competition?.competitionId,
    from: schedule.from,
    to: schedule.to,
  };
}

function scheduleSource(
  kind: 'online' | 'fixture',
  value: unknown,
  request: ScheduleWindowRequest,
) {
  return { kind, request, load: () => Promise.resolve(value) } as const;
}

function scheduleFailureSource(
  kind: 'online' | 'fixture',
  request: ScheduleWindowRequest,
  error: Error,
) {
  return { kind, request, load: () => Promise.reject(error) } as const;
}

function deferred<T>() {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolveValue, rejectValue) => {
    resolvePromise = resolveValue;
    rejectPromise = rejectValue;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('Match Manifest last-known-good seam', () => {
  it('saves one versioned envelope and restores its raw DTO with stale metadata', async () => {
    const root = await temporaryDirectory();
    const manifest = await readFixture<BroadcastManifest>('broadcast-manifest-v1.valid.json');
    const filePath = join(root, 'manifest.json');
    const store = new MatchManifestLkgStore({
      filePath,
      clock: () => '2026-09-16T12:00:00.000Z',
    });

    const saved = await store.save(manifest, 'online', { localAuthoringMode: 'standalone' });
    const restored = await store.read(manifest.match.matchId);

    expect(saved.ok).toBe(true);
    expect(restored.ok).toBe(true);
    if (!restored.ok) throw new Error('saved LKG should restore');
    expect(restored.value.origin).toBe('cache');
    expect(restored.value.freshness).toBe('stale');
    expect(restored.value.cachedFrom).toBe('online');
    expect(restored.value.localAuthoringMode).toBe('bound-overlay');
    expect(restored.value.storedAt).toBe('2026-09-16T12:00:00.000Z');
    expect(restored.value.manifest).toEqual(manifest);
    expect(restored.value.context.matchId).toBe(manifest.match.matchId);

    const envelope = JSON.parse(await readFile(filePath, 'utf8')) as Record<string, unknown>;
    expect(envelope).toEqual({
      cacheVersion: MATCH_CONTEXT_CACHE_VERSION,
      metadata: {
        matchId: manifest.match.matchId,
        origin: 'online',
        storedAt: '2026-09-16T12:00:00.000Z',
        localAuthoringMode: 'bound-overlay',
      },
      payload: manifest,
    });
    await expect(readFile(`${filePath}.meta.json`, 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('uses the same-shape local fixture as a Companion source', async () => {
    const root = await temporaryDirectory();
    const manifestPath = join(fixtureRoot, 'broadcast-manifest-v1.valid.json');
    const manifest = await readFixture<BroadcastManifest>('broadcast-manifest-v1.valid.json');
    const controller = new MatchContextController({
      lkgStore: new MatchManifestLkgStore({ filePath: join(root, 'manifest.json') }),
    });

    const result = await controller.selectMatch(
      manifest.match.matchId,
      createFixtureManifestSource(manifestPath),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('same-shape fixture should bind');
    expect(result.binding.origin).toBe('fixture');
    expect(result.binding.freshness).toBe('fresh');
  });

  it('does not overwrite a valid LKG with malformed or semantically invalid input', async () => {
    const root = await temporaryDirectory();
    const manifest = await readFixture<BroadcastManifest>('broadcast-manifest-v1.valid.json');
    const store = new MatchManifestLkgStore({ filePath: join(root, 'manifest.json') });
    expect((await store.save(manifest, 'fixture')).ok).toBe(true);

    const malformed = { ...manifest, schemaVersion: 'rivalhub.broadcast-manifest.v9' };
    const invalid = await store.save(malformed, 'online');
    const restored = await store.read(manifest.match.matchId);

    expect(invalid.ok).toBe(false);
    expect(restored.ok).toBe(true);
    if (!restored.ok) throw new Error('original LKG should remain');
    expect(restored.value.manifest.revision).toBe(manifest.revision);
  });

  it.each(['before-write', 'after-write', 'before-rename'] as DurableJsonCommitPoint[])(
    'preserves the old Manifest envelope when the %s commit step fails',
    async (failurePoint) => {
      const root = await temporaryDirectory();
      const manifest = await readFixture<BroadcastManifest>('broadcast-manifest-v1.valid.json');
      const filePath = join(root, 'manifest.json');
      const baseline = new MatchManifestLkgStore({
        filePath,
        clock: () => '2026-09-16T12:00:00.000Z',
      });
      expect((await baseline.save(manifest, 'fixture')).ok).toBe(true);
      const candidate = structuredClone(manifest) as {
        revision: string;
        match: { matchId: string };
      };
      candidate.revision = 'revision-after-fault';
      const faulty = new MatchManifestLkgStore({
        filePath,
        faultInjector: (point) => {
          if (point === failurePoint) throw new Error(`injected ${point}`);
        },
      });

      const failed = await faulty.save(candidate, 'online');
      const restored = await baseline.read(manifest.match.matchId);
      const files = await readdir(root);

      expect(failed.ok).toBe(false);
      if (failed.ok) throw new Error('faulted commit should fail');
      expect(failed.issue.code).toBe('lkg_write_failed');
      expect(restored.ok).toBe(true);
      if (!restored.ok) throw new Error('old LKG should remain readable');
      expect(restored.value.manifest.revision).toBe(manifest.revision);
      expect(restored.value.cachedFrom).toBe('fixture');
      expect(files.filter((file) => file.endsWith('.tmp'))).toEqual([]);
    },
  );

  it('only restores an exact requested match and never chooses a nearest match', async () => {
    const root = await temporaryDirectory();
    const manifest = await readFixture<BroadcastManifest>('broadcast-manifest-v1.valid.json');
    const store = new MatchManifestLkgStore({ filePath: join(root, 'manifest.json') });
    expect((await store.save(manifest, 'online')).ok).toBe(true);

    const different = await store.read('match-m2-not-the-current-one');
    expect(different.ok).toBe(false);
    if (different.ok) throw new Error('different match must not restore');
    expect(different.issue.code).toBe('lkg_match_mismatch');
  });

  it('commits only the latest deferred MatchContext selection', async () => {
    const root = await temporaryDirectory();
    const manifest = await readFixture<BroadcastManifest>('broadcast-manifest-v1.valid.json');
    const nextManifest = structuredClone(manifest) as {
      revision: string;
      match: { matchId: string };
    };
    nextManifest.match.matchId = 'match-m2-02';
    nextManifest.revision = 'revision-next';
    const store = new MatchManifestLkgStore({ filePath: join(root, 'manifest.json') });
    const controller = new MatchContextController({ lkgStore: store });
    const oldLoad = deferred<unknown>();

    const oldSelection = controller.selectMatch(manifest.match.matchId, {
      kind: 'online',
      load: () => oldLoad.promise,
    });
    const latestSelection = controller.selectMatch(
      nextManifest.match.matchId,
      source('online', nextManifest),
    );
    const latestResult = await latestSelection;
    oldLoad.resolve(manifest);
    const oldResult = await oldSelection;

    expect(latestResult.ok).toBe(true);
    expect(oldResult.ok).toBe(false);
    if (oldResult.ok) throw new Error('superseded selection must not commit');
    expect(oldResult.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(['selection_stale']);
    expect(controller.getActiveBinding()?.context.matchId).toBe('match-m2-02');
    const lkg = await store.read('match-m2-02');
    expect(lkg.ok).toBe(true);
    if (!lkg.ok) throw new Error('latest selection should own LKG');
    expect(lkg.value.manifest.revision).toBe('revision-next');
  });

  it('clears A before selecting B, so B failure cannot leak A branding', async () => {
    const root = await temporaryDirectory();
    const manifest = await readFixture<BroadcastManifest>('broadcast-manifest-v1.valid.json');
    const store = new MatchManifestLkgStore({ filePath: join(root, 'manifest.json') });
    const controller = new MatchContextController({ lkgStore: store });
    const first = await controller.selectMatch(manifest.match.matchId, source('fixture', manifest));
    expect(first.ok).toBe(true);
    expect(controller.getActiveBinding()?.context.matchId).toBe(manifest.match.matchId);

    const failed = await controller.selectMatch('match-m2-next', {
      kind: 'online',
      load: () => Promise.reject(new SourceLoadError('offline')),
    });

    expect(failed.ok).toBe(false);
    expect(controller.getActiveBinding()).toBeUndefined();
    expect(failed.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(
      expect.arrayContaining(['source_load_failed', 'lkg_unavailable']),
    );
  });

  it('keeps the same-match in-memory binding when refresh fails', async () => {
    const root = await temporaryDirectory();
    const manifest = await readFixture<BroadcastManifest>('broadcast-manifest-v1.valid.json');
    const candidate = structuredClone(manifest) as unknown as {
      revision: string;
      match: { matchId: string };
    };
    candidate.revision = 'revision-memory';
    const baselinePath = join(root, 'baseline.json');
    const baseline = new MatchManifestLkgStore({ filePath: baselinePath });
    expect((await baseline.save(manifest, 'fixture')).ok).toBe(true);
    const controller = new MatchContextController({
      lkgStore: new MatchManifestLkgStore({
        filePath: baselinePath,
        faultInjector: (point) => {
          if (point === 'before-rename') throw new Error('injected commit failure');
        },
      }),
    });

    const fresh = await controller.selectMatch(manifest.match.matchId, source('online', candidate));
    expect(fresh.ok).toBe(true);
    if (!fresh.ok) throw new Error('fresh same-match candidate should bind');
    const failedRefresh = await controller.selectMatch(manifest.match.matchId, {
      kind: 'online',
      load: () => Promise.reject(new SourceLoadError('offline')),
    });

    expect(failedRefresh.ok).toBe(true);
    if (!failedRefresh.ok) throw new Error('same-match memory binding should remain usable');
    expect(failedRefresh.binding.manifest.revision).toBe('revision-memory');
    expect(failedRefresh.binding.freshness).toBe('stale');
    expect(failedRefresh.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      'source_load_failed',
      'memory_fallback',
    ]);
  });

  it('cancels an in-flight selection when clearActive is called', async () => {
    const root = await temporaryDirectory();
    const manifest = await readFixture<BroadcastManifest>('broadcast-manifest-v1.valid.json');
    const controller = new MatchContextController({
      lkgStore: new MatchManifestLkgStore({ filePath: join(root, 'manifest.json') }),
    });
    const pending = deferred<unknown>();
    const selection = controller.selectMatch(manifest.match.matchId, {
      kind: 'online',
      load: () => pending.promise,
    });

    controller.clearActive();
    pending.resolve(manifest);
    const result = await selection;

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('cleared selection must not rebind');
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(['selection_stale']);
    expect(controller.getActiveBinding()).toBeUndefined();
  });

  it('carries contract warnings into fresh and restored MatchContext bindings', async () => {
    const root = await temporaryDirectory();
    const manifest = await readFixture<BroadcastManifest>('broadcast-manifest-v1.valid.json');
    const candidate = structuredClone(manifest) as unknown as {
      entrants: {
        a: { roster: { players: Array<{ steam64: string | null; displayName: string | null }> } };
      };
    };
    candidate.entrants.a.roster.players = candidate.entrants.a.roster.players.slice(0, 4);
    candidate.entrants.a.roster.players[0]!.steam64 = null;
    candidate.entrants.a.roster.players[0]!.displayName = null;
    const filePath = join(root, 'manifest.json');
    const store = new MatchManifestLkgStore({ filePath });
    const controller = new MatchContextController({ lkgStore: store });

    const fresh = await controller.selectMatch(
      manifest.match.matchId,
      source('fixture', candidate),
    );
    expect(fresh.ok).toBe(true);
    if (!fresh.ok) throw new Error('warning-bearing candidate should bind');
    expect(fresh.binding.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(
      expect.arrayContaining(['missing_steam64', 'missing_display_name', 'incomplete_roster']),
    );
    expect(fresh.diagnostics).toEqual([]);

    const restored = await store.read(manifest.match.matchId);
    expect(restored.ok).toBe(true);
    if (!restored.ok) throw new Error('warning-bearing LKG should restore');
    expect(restored.value.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(
      expect.arrayContaining(['missing_steam64', 'missing_display_name', 'incomplete_roster']),
    );
    expect(restored.diagnostics).toEqual(restored.value.diagnostics);
  });

  it('keeps a fresh MatchContext when its LKG persistence fails', async () => {
    const root = await temporaryDirectory();
    const manifest = await readFixture<BroadcastManifest>('broadcast-manifest-v1.valid.json');
    const filePath = join(root, 'manifest.json');
    const store = new MatchManifestLkgStore({
      filePath,
      faultInjector: (point) => {
        if (point === 'before-rename') throw new Error('injected commit failure');
      },
    });
    const controller = new MatchContextController({ lkgStore: store });

    const result = await controller.selectMatch(manifest.match.matchId, source('online', manifest));

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('fresh candidate should remain usable');
    expect(result.binding.freshness).toBe('fresh');
    expect(result.binding.origin).toBe('online');
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'lkg_persistence_failed' })]),
    );
    const lkg = await store.read(manifest.match.matchId);
    expect(lkg.ok).toBe(false);
    if (lkg.ok) throw new Error('failed first commit must not create an LKG');
    expect(lkg.issue.code).toBe('lkg_not_found');
  });

  it('uses same-match LKG on source failure and restores deterministically after process restart', async () => {
    const root = await temporaryDirectory();
    const manifest = await readFixture<BroadcastManifest>('broadcast-manifest-v1.valid.json');
    const filePath = join(root, 'manifest.json');
    const store = new MatchManifestLkgStore({ filePath });
    const controller = new MatchContextController({ lkgStore: store });
    expect(
      (await controller.selectMatch(manifest.match.matchId, source('online', manifest))).ok,
    ).toBe(true);

    const restarted = new MatchContextController({
      lkgStore: new MatchManifestLkgStore({ filePath }),
    });
    const result = await restarted.selectMatch(manifest.match.matchId, {
      kind: 'online',
      load: () => Promise.reject(new SourceLoadError('offline')),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('same-match LKG should be used');
    expect(result.binding.origin).toBe('cache');
    expect(result.binding.freshness).toBe('stale');
    expect(result.binding.context).toEqual(controller.getActiveBinding()?.context);
  });

  it('rejects an unsupported-schema payload in the versioned envelope', async () => {
    const root = await temporaryDirectory();
    const filePath = join(root, 'manifest.json');
    const manifest = await readFixture<BroadcastManifest>('broadcast-manifest-v1.valid.json');
    const store = new MatchManifestLkgStore({ filePath });
    expect((await store.save(manifest, 'fixture')).ok).toBe(true);
    const envelope = JSON.parse(await readFile(filePath, 'utf8')) as {
      payload: Record<string, unknown>;
    };
    envelope.payload.schemaVersion = 'rivalhub.broadcast-manifest.v9';
    await writeFile(filePath, `${JSON.stringify(envelope)}\n`, 'utf8');

    const result = await store.read(manifest.match.matchId);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unsupported schema must not restore');
    expect(result.issue.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'unsupported_schema_version' })]),
    );
  });

  it('does not classify callback failures as source_load_failed', async () => {
    const root = await temporaryDirectory();
    const manifest = await readFixture<BroadcastManifest>('broadcast-manifest-v1.valid.json');
    const callbackError = new Error('binding callback failed');
    const controller = new MatchContextController({
      lkgStore: new MatchManifestLkgStore({ filePath: join(root, 'manifest.json') }),
      onBindingChanged: (binding) => {
        if (binding !== undefined) throw callbackError;
      },
    });

    await expect(
      controller.selectMatch(manifest.match.matchId, source('online', manifest)),
    ).rejects.toBe(callbackError);
  });

  it('propagates untyped source-loader errors instead of masking them as source_load_failed', async () => {
    const root = await temporaryDirectory();
    const manifest = await readFixture<BroadcastManifest>('broadcast-manifest-v1.valid.json');
    const programmerError = new TypeError('source callback invariant failed');
    const controller = new MatchContextController({
      lkgStore: new MatchManifestLkgStore({ filePath: join(root, 'manifest.json') }),
    });

    await expect(
      controller.selectMatch(manifest.match.matchId, {
        kind: 'online',
        load: () => Promise.reject(programmerError),
      }),
    ).rejects.toBe(programmerError);
  });
});

describe('independent ScheduleWindow last-known-good seam', () => {
  it('writes and reads only the canonical Mizar ScheduleWindow cache version', async () => {
    const root = await temporaryDirectory();
    const schedule = await readFixture<BroadcastScheduleWindowV1>(
      'broadcast-schedule-window-v1.valid.json',
    );
    const filePath = join(root, 'schedule.json');
    const request = scheduleRequest(schedule);
    const writer = new ScheduleWindowLkgStore({ filePath });

    expect((await writer.save(schedule, 'fixture')).ok).toBe(true);
    const envelope = JSON.parse(await readFile(filePath, 'utf8')) as Record<string, unknown>;
    expect(envelope.cacheVersion).toBe(SCHEDULE_WINDOW_CACHE_VERSION);
    const restored = await new ScheduleWindowLkgStore({ filePath }).read(request);

    expect(restored).toMatchObject({
      ok: true,
      value: { origin: 'cache', cachedFrom: 'fixture' },
    });
  });

  it('requires a source response to match its requested competition and exact window', async () => {
    const root = await temporaryDirectory();
    const schedule = await readFixture<BroadcastScheduleWindowV1>(
      'broadcast-schedule-window-v1.valid.json',
    );
    const request = {
      ...scheduleRequest(schedule),
      to: '2026-09-16T15:00:00.000Z',
    };
    const controller = new ScheduleWindowController({
      lkgStore: new ScheduleWindowLkgStore({ filePath: join(root, 'schedule.json') }),
    });

    const result = await controller.refresh(scheduleSource('online', schedule, request));

    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      'schedule_source_request_mismatch',
      'schedule_lkg_unavailable',
    ]);
    expect(controller.getCurrent()).toBeUndefined();
  });

  it('does not reuse memory or disk LKG from an incompatible schedule request', async () => {
    const root = await temporaryDirectory();
    const schedule = await readFixture<BroadcastScheduleWindowV1>(
      'broadcast-schedule-window-v1.valid.json',
    );
    const filePath = join(root, 'schedule.json');
    const store = new ScheduleWindowLkgStore({ filePath });
    const controller = new ScheduleWindowController({ lkgStore: store });
    const firstRequest = scheduleRequest(schedule);
    expect((await store.save(schedule, 'fixture')).ok).toBe(true);
    expect((await controller.refresh(scheduleSource('fixture', schedule, firstRequest))).ok).toBe(
      true,
    );

    const incompatibleRequest: ScheduleWindowRequest = {
      competitionId: 'competition-other',
      from: '2026-09-16T14:00:00.000Z',
      to: '2026-09-16T18:00:00.000Z',
    };
    const result = await controller.refresh(
      scheduleFailureSource(
        'online',
        incompatibleRequest,
        new SourceLoadError('schedule service offline'),
      ),
    );

    expect(result.ok).toBe(false);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'schedule_source_failed' })]),
    );
    const unavailable = result.diagnostics.find(
      (diagnostic) => diagnostic.code === 'schedule_lkg_unavailable',
    );
    expect(unavailable?.storeIssue?.code).toBe('schedule_lkg_request_mismatch');
    expect(controller.getCurrent()).toBeUndefined();
  });

  it('refreshes online data and retains stale schedule when the next source fails', async () => {
    const root = await temporaryDirectory();
    const schedule = await readFixture<BroadcastScheduleWindowV1>(
      'broadcast-schedule-window-v1.valid.json',
    );
    const store = new ScheduleWindowLkgStore({
      filePath: join(root, 'schedule.json'),
      clock: () => '2026-09-16T12:01:00.000Z',
    });
    const controller = new ScheduleWindowController({ lkgStore: store });

    const request = scheduleRequest(schedule);
    const fresh = await controller.refresh(scheduleSource('online', schedule, request));
    const stale = await controller.refresh(
      scheduleFailureSource('online', request, new SourceLoadError('schedule service offline')),
    );

    expect(fresh.ok).toBe(true);
    expect(stale.ok).toBe(true);
    if (!stale.ok) throw new Error('schedule LKG should remain available');
    expect(stale.binding.origin).toBe('online');
    expect(stale.binding.freshness).toBe('stale');
    expect(stale.binding.schedule.revision).toBe(schedule.revision);
    expect(stale.binding.window.matches[0]?.matchId).toBe('match-m2-00');
    expect(stale.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'schedule_source_failed' })]),
    );
  });

  it('uses the disk ScheduleWindow LKG only when the controller has no memory binding', async () => {
    const root = await temporaryDirectory();
    const schedule = await readFixture<BroadcastScheduleWindowV1>(
      'broadcast-schedule-window-v1.valid.json',
    );
    const filePath = join(root, 'schedule.json');
    const writer = new ScheduleWindowLkgStore({ filePath });
    expect((await writer.save(schedule, 'fixture')).ok).toBe(true);
    const controller = new ScheduleWindowController({
      lkgStore: new ScheduleWindowLkgStore({ filePath }),
    });

    const result = await controller.refresh(
      scheduleFailureSource(
        'online',
        scheduleRequest(schedule),
        new SourceLoadError('schedule service offline'),
      ),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('disk ScheduleWindow LKG should be available');
    expect(result.binding.origin).toBe('cache');
    expect(result.binding.freshness).toBe('stale');
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      'schedule_source_failed',
      'schedule_lkg_fallback',
    ]);
  });

  it.each(['before-write', 'after-write', 'before-rename'] as DurableJsonCommitPoint[])(
    'preserves the old ScheduleWindow envelope when the %s commit step fails',
    async (failurePoint) => {
      const root = await temporaryDirectory();
      const schedule = await readFixture<BroadcastScheduleWindowV1>(
        'broadcast-schedule-window-v1.valid.json',
      );
      const filePath = join(root, 'schedule.json');
      const baseline = new ScheduleWindowLkgStore({
        filePath,
        clock: () => '2026-09-16T12:00:00.000Z',
      });
      expect((await baseline.save(schedule, 'fixture')).ok).toBe(true);
      const candidate = structuredClone(schedule) as { revision: string };
      candidate.revision = 'revision-after-fault';
      const faulty = new ScheduleWindowLkgStore({
        filePath,
        faultInjector: (point) => {
          if (point === failurePoint) throw new Error(`injected ${point}`);
        },
      });

      const failed = await faulty.save(candidate, 'online');
      const restored = await baseline.read();
      const files = await readdir(root);

      expect(failed.ok).toBe(false);
      if (failed.ok) throw new Error('faulted commit should fail');
      expect(failed.issue.code).toBe('schedule_lkg_write_failed');
      expect(restored.ok).toBe(true);
      if (!restored.ok) throw new Error('old schedule LKG should remain readable');
      expect(restored.value.schedule.revision).toBe(schedule.revision);
      expect(restored.value.cachedFrom).toBe('fixture');
      expect(files.filter((file) => file.endsWith('.tmp'))).toEqual([]);
    },
  );

  it('returns the fresh validated schedule when persistence fails instead of falling back stale', async () => {
    const root = await temporaryDirectory();
    const schedule = await readFixture<BroadcastScheduleWindowV1>(
      'broadcast-schedule-window-v1.valid.json',
    );
    const filePath = join(root, 'schedule.json');
    const store = new ScheduleWindowLkgStore({
      filePath,
      faultInjector: (point) => {
        if (point === 'before-rename') throw new Error('injected commit failure');
      },
    });

    const controller = new ScheduleWindowController({ lkgStore: store });
    const result = await controller.refresh(
      scheduleSource('online', schedule, scheduleRequest(schedule)),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('fresh validated schedule should remain active');
    expect(result.binding.origin).toBe('online');
    expect(result.binding.freshness).toBe('fresh');
    expect(result.binding.schedule.revision).toBe(schedule.revision);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'schedule_lkg_persistence_failed' }),
      ]),
    );
    expect(controller.getCurrent()).toEqual(result.binding);
    const lkg = await store.read();
    expect(lkg.ok).toBe(false);
    if (lkg.ok) throw new Error('failed first commit must not create an LKG');
    expect(lkg.issue.code).toBe('schedule_lkg_not_found');
  });

  it('commits only the latest deferred ScheduleWindow refresh', async () => {
    const root = await temporaryDirectory();
    const schedule = await readFixture<BroadcastScheduleWindowV1>(
      'broadcast-schedule-window-v1.valid.json',
    );
    const nextSchedule = structuredClone(schedule) as BroadcastScheduleWindowV1 & {
      revision: string;
    };
    nextSchedule.revision = 'revision-next';
    const store = new ScheduleWindowLkgStore({ filePath: join(root, 'schedule.json') });
    const controller = new ScheduleWindowController({ lkgStore: store });
    const oldLoad = deferred<unknown>();

    const request = scheduleRequest(schedule);
    const oldRefresh = controller.refresh({ kind: 'online', request, load: () => oldLoad.promise });
    const latestRefresh = controller.refresh(
      scheduleSource('online', nextSchedule, scheduleRequest(nextSchedule)),
    );
    const latestResult = await latestRefresh;
    oldLoad.resolve(schedule);
    const oldResult = await oldRefresh;

    expect(latestResult.ok).toBe(true);
    expect(oldResult.ok).toBe(false);
    if (oldResult.ok) throw new Error('superseded refresh must not commit');
    expect(oldResult.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      'schedule_refresh_stale',
    ]);
    expect(controller.getCurrent()?.schedule.revision).toBe('revision-next');
    const envelope = JSON.parse(await readFile(join(root, 'schedule.json'), 'utf8')) as {
      payload: { revision: string };
    };
    expect(envelope.payload.revision).toBe('revision-next');
  });

  it('clears the current schedule and cancels an in-flight refresh', async () => {
    const root = await temporaryDirectory();
    const schedule = await readFixture<BroadcastScheduleWindowV1>(
      'broadcast-schedule-window-v1.valid.json',
    );
    const controller = new ScheduleWindowController({
      lkgStore: new ScheduleWindowLkgStore({ filePath: join(root, 'schedule.json') }),
    });
    const pending = deferred<unknown>();
    const refresh = controller.refresh({
      kind: 'online',
      request: scheduleRequest(schedule),
      load: () => pending.promise,
    });

    controller.clearCurrent();
    pending.resolve(schedule);
    const result = await refresh;

    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      'schedule_refresh_stale',
    ]);
    expect(controller.getCurrent()).toBeUndefined();
  });

  it('prefers the current in-memory ScheduleWindow over an older disk LKG', async () => {
    const root = await temporaryDirectory();
    const schedule = await readFixture<BroadcastScheduleWindowV1>(
      'broadcast-schedule-window-v1.valid.json',
    );
    const nextSchedule = structuredClone(schedule) as BroadcastScheduleWindowV1 & {
      revision: string;
    };
    nextSchedule.revision = 'revision-memory';
    const filePath = join(root, 'schedule.json');
    const baseline = new ScheduleWindowLkgStore({ filePath });
    expect((await baseline.save(schedule, 'fixture')).ok).toBe(true);
    const store = new ScheduleWindowLkgStore({
      filePath,
      faultInjector: (point) => {
        if (point === 'before-rename') throw new Error('injected commit failure');
      },
    });
    const controller = new ScheduleWindowController({ lkgStore: store });

    const request = scheduleRequest(nextSchedule);
    const fresh = await controller.refresh(scheduleSource('online', nextSchedule, request));
    expect(fresh.ok).toBe(true);
    if (!fresh.ok) throw new Error('fresh schedule should remain active');
    const failedRefresh = await controller.refresh(
      scheduleFailureSource('online', request, new SourceLoadError('schedule service offline')),
    );

    expect(failedRefresh.ok).toBe(true);
    if (!failedRefresh.ok) throw new Error('memory schedule should remain active');
    expect(failedRefresh.binding.schedule.revision).toBe('revision-memory');
    expect(failedRefresh.binding.freshness).toBe('stale');
    expect(failedRefresh.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      'schedule_source_failed',
      'schedule_memory_fallback',
    ]);
  });

  it('carries contract diagnostics into fresh and restored ScheduleWindow bindings', async () => {
    const root = await temporaryDirectory();
    const schedule = await readFixture<BroadcastScheduleWindowV1>(
      'broadcast-schedule-window-v1.valid.json',
    );
    const filePath = join(root, 'schedule.json');
    const store = new ScheduleWindowLkgStore({ filePath });
    const controller = new ScheduleWindowController({ lkgStore: store });

    const fresh = await controller.refresh(
      scheduleSource('fixture', schedule, scheduleRequest(schedule)),
    );
    expect(fresh.ok).toBe(true);
    if (!fresh.ok) throw new Error('valid schedule should bind');
    expect(fresh.binding.diagnostics).toEqual([]);

    const restored = await store.read();
    expect(restored.ok).toBe(true);
    if (!restored.ok) throw new Error('valid schedule LKG should restore');
    expect(restored.value.diagnostics).toEqual(fresh.binding.diagnostics);
  });

  it('does not couple schedule failure to an active MatchContext', async () => {
    const root = await temporaryDirectory();
    const manifest = await readFixture<BroadcastManifest>('broadcast-manifest-v1.valid.json');
    const schedule = await readFixture<BroadcastScheduleWindowV1>(
      'broadcast-schedule-window-v1.valid.json',
    );
    const matchStore = new MatchManifestLkgStore({ filePath: join(root, 'manifest.json') });
    const controller = new MatchContextController({ lkgStore: matchStore });
    expect(
      (await controller.selectMatch(manifest.match.matchId, source('fixture', manifest))).ok,
    ).toBe(true);
    const before = controller.getActiveBinding();
    const scheduleStore = new ScheduleWindowLkgStore({ filePath: join(root, 'schedule.json') });
    const scheduleController = new ScheduleWindowController({ lkgStore: scheduleStore });
    expect((await scheduleStore.save(schedule, 'fixture')).ok).toBe(true);

    const failure = await scheduleController.refresh(
      scheduleSource(
        'fixture',
        { ...schedule, revision: 'broken', from: 'not-a-time' },
        scheduleRequest(schedule),
      ),
    );

    expect(failure.ok).toBe(true);
    expect(controller.getActiveBinding()).toEqual(before);
  });

  it('propagates untyped ScheduleWindow source-loader errors', async () => {
    const root = await temporaryDirectory();
    const programmerError = new TypeError('schedule source callback invariant failed');
    const controller = new ScheduleWindowController({
      lkgStore: new ScheduleWindowLkgStore({ filePath: join(root, 'schedule.json') }),
    });

    await expect(
      controller.refresh(
        scheduleFailureSource(
          'online',
          {
            competitionId: 'competition-m2',
            from: '2026-09-16T08:00:00.000Z',
            to: '2026-09-16T14:00:00.000Z',
          },
          programmerError,
        ),
      ),
    ).rejects.toBe(programmerError);
  });
});
