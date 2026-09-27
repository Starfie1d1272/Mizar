import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import { DEFAULT_LOCAL_BP_MAP_POOL, inspectBp, localBpSequence } from '@mizar/core/projection';
import {
  toMatchContext,
  validateBroadcastManifest,
  type BroadcastManifestV1,
} from '@mizar/rivalhub';
import { describe, expect, it } from 'vitest';

import { bpAuthoringDraftFromBinding, createLocalBpManifest } from '../src/bp/local-draft.js';
import { MatchContextController } from '../src/match-context/controller.js';
import { MatchManifestLkgStore, type MatchContextBinding } from '../src/match-context/lkg-store.js';
import { SourceLoadError } from '../src/match-context/source-error.js';

function draftFor(format: 'bo1' | 'bo3' | 'bo5') {
  const mapPool = [...DEFAULT_LOCAL_BP_MAP_POOL];
  const banIndexes =
    format === 'bo1' ? [0, 1, 2, 3, 4, 5] : format === 'bo3' ? [0, 1, 4, 5] : [0, 1];
  const pickIndexes = format === 'bo1' ? [] : format === 'bo3' ? [2, 3] : [2, 3, 4, 5];
  return {
    competitionName: 'NJU Rivals',
    stage: '决赛',
    format,
    entrants: {
      a: { name: '完整左队名', logoUrl: null },
      b: { name: "Team D'avenir", logoUrl: null },
    },
    vetoA: 'a' as const,
    mapPool,
    bans: banIndexes.map((index) => mapPool[index]!),
    picks: pickIndexes.map((index, position) => ({
      mapName: mapPool[index]!,
      side: position % 2 === 0 ? ('CT' as const) : ('T' as const),
    })),
    deciderSide: format === 'bo5' ? null : ('T' as const),
  };
}

async function knownManifest(): Promise<BroadcastManifestV1> {
  const candidate: unknown = JSON.parse(
    await readFile(
      resolve(process.cwd(), 'packages/rivalhub/test/fixtures/broadcast-manifest-v1.valid.json'),
      'utf8',
    ),
  );
  const result = validateBroadcastManifest(candidate);
  if (!result.ok) throw new Error('Companion test Manifest fixture is invalid');
  return result.value;
}

function bindingFor(
  manifest: BroadcastManifestV1,
  origin: MatchContextBinding['origin'],
): MatchContextBinding {
  return {
    manifest,
    context: toMatchContext(manifest),
    origin,
    freshness: 'fresh',
    localAuthoringMode: origin === 'local' ? 'standalone' : 'bound-overlay',
    diagnostics: [],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function boundBo3Draft(manifest: BroadcastManifestV1) {
  return {
    ...bpAuthoringDraftFromBinding(bindingFor(manifest, 'online')),
    mapPool: [
      'de_ancient',
      'de_mirage',
      'de_nuke',
      'de_dust2',
      'de_inferno',
      'de_anubis',
      'de_cache',
    ],
    bans: ['de_dust2', 'de_inferno', 'de_anubis', 'de_cache'],
    picks: [
      { mapName: 'de_ancient', side: 'CT' as const },
      { mapName: 'de_mirage', side: 'T' as const },
    ],
    deciderSide: 'CT' as const,
  };
}

describe('local BP authoring', () => {
  it.each([
    ['bo1', ['ban', 'ban', 'ban', 'ban', 'ban', 'ban', 'decider', 'side_pick']],
    [
      'bo3',
      [
        'ban',
        'ban',
        'pick',
        'side_pick',
        'pick',
        'side_pick',
        'ban',
        'ban',
        'decider',
        'side_pick',
      ],
    ],
    [
      'bo5',
      [
        'ban',
        'ban',
        'pick',
        'side_pick',
        'pick',
        'side_pick',
        'pick',
        'side_pick',
        'pick',
        'side_pick',
        'decider',
      ],
    ],
  ] as const)(
    'compiles the canonical %s sequence to a valid Manifest and BP context',
    (format, kinds) => {
      const result = createLocalBpManifest(draftFor(format));
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.manifest.veto.map((step) => step.actionType)).toEqual(kinds);
      expect(
        result.manifest.veto.map((step) =>
          step.actionType === 'decider'
            ? null
            : step.entryId === result.manifest.entrants.a.entryId
              ? 'a'
              : step.entryId === result.manifest.entrants.b.entryId
                ? 'b'
                : null,
        ),
      ).toEqual(localBpSequence(format, 'a').map((step) => step.actor));
      expect(validateBroadcastManifest(result.manifest).ok).toBe(true);
      const projection = inspectBp(toMatchContext(result.manifest));
      expect(projection.readiness).toBe('ready');
      expect(projection.projection?.entrants.a.name).toBe('完整左队名');
      expect(projection.projection?.entrants.b.name).toBe("Team D'avenir");
      expect(result.manifest.maps).toHaveLength(format === 'bo1' ? 1 : format === 'bo3' ? 3 : 5);
      expect(result.manifest.maps.at(-1)?.mapName).toBe('de_cache');
      expect(projection.projection?.cards.at(-1)?.sideChoice).toEqual(
        format === 'bo5' ? null : { entrant: 'b', side: 'T' },
      );
    },
  );

  it('keeps match A/B identity fixed when Veto A changes', () => {
    const draft = { ...draftFor('bo3'), vetoA: 'b' as const };
    const result = createLocalBpManifest(draft);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.manifest.entrants.a.name).toBe('完整左队名');
    expect(result.manifest.entrants.b.name).toBe("Team D'avenir");
    expect(result.manifest.veto[0]?.entryId).toBe(result.manifest.entrants.b.entryId);
    expect(result.manifest.veto[2]?.entryId).toBe(result.manifest.entrants.b.entryId);
    expect(result.manifest.veto[3]?.entryId).toBe(result.manifest.entrants.a.entryId);
  });

  it('rejects duplicate maps, incomplete sides, and a BO5 decider side', () => {
    const draft = draftFor('bo3');
    expect(
      createLocalBpManifest({
        ...draft,
        bans: [draft.bans[0], draft.bans[0], ...draft.bans.slice(2)],
      }),
    ).toMatchObject({ ok: false, code: 'bp_draft_maps_duplicate' });
    expect(
      createLocalBpManifest({
        ...draft,
        picks: [{ ...draft.picks[0]!, side: null }, draft.picks[1]!],
      }),
    ).toMatchObject({ ok: false, code: 'bp_draft_sides_incomplete' });
    expect(createLocalBpManifest({ ...draftFor('bo5'), deciderSide: 'CT' })).toMatchObject({
      ok: false,
      code: 'bp_draft_decider_knife',
    });
    expect(createLocalBpManifest({ ...draft, mapPool: draft.mapPool.slice(1) })).toMatchObject({
      ok: false,
      code: 'bp_draft_map_pool_invalid',
    });
  });

  it('recovers unambiguous explicit and legacy sides from an incomplete BP', async () => {
    const original = await knownManifest();
    const entryA = original.entrants.a.entryId;
    const entryB = original.entrants.b.entryId;
    const partial = (
      pickSide: 'ct' | null,
      explicitSide: 'ct' | 't' | null,
    ): BroadcastManifestV1 => ({
      ...original,
      match: { ...original.match, format: 'bo3' },
      maps: original.maps.map((map) =>
        map.mapName === 'de_ancient' ? { ...map, teamAStartSide: null } : map,
      ),
      veto: [
        { stepOrder: 1, actionType: 'ban', mapName: 'de_nuke', entryId: entryA, side: null },
        { stepOrder: 2, actionType: 'ban', mapName: 'de_inferno', entryId: entryB, side: null },
        {
          stepOrder: 3,
          actionType: 'pick',
          mapName: 'de_ancient',
          entryId: entryA,
          side: pickSide,
        },
        ...(explicitSide === null
          ? []
          : [
              {
                stepOrder: 4,
                actionType: 'side_pick' as const,
                mapName: 'de_ancient',
                entryId: entryB,
                side: explicitSide,
              },
            ]),
      ],
    });
    const explicit = bindingFor(partial(null, 'ct'), 'online');
    const legacy = bindingFor(partial('ct', null), 'online');
    const conflict = bindingFor(partial('ct', 't'), 'online');
    const separatedSource = partial(null, null);
    const separatedExplicit = bindingFor(
      {
        ...separatedSource,
        veto: [
          ...separatedSource.veto,
          { stepOrder: 4, actionType: 'ban', mapName: 'de_mirage', entryId: entryB, side: null },
          {
            stepOrder: 5,
            actionType: 'side_pick',
            mapName: 'de_ancient',
            entryId: entryB,
            side: 'ct',
          },
        ],
      },
      'online',
    );
    const deciderSource = partial(null, null);
    const legacyDecider = bindingFor(
      {
        ...deciderSource,
        veto: [
          ...deciderSource.veto.slice(0, 2),
          {
            stepOrder: 3,
            actionType: 'decider',
            mapName: 'de_ancient',
            entryId: entryB,
            side: 'ct',
          },
        ],
      },
      'online',
    );

    expect(inspectBp(explicit.context).readiness).toBe('incomplete');
    expect(inspectBp(separatedExplicit.context).readiness).toBe('conflict');
    expect(bpAuthoringDraftFromBinding(explicit).picks[0]?.side).toBe('CT');
    expect(bpAuthoringDraftFromBinding(separatedExplicit).picks[0]?.side).toBe('CT');
    expect(bpAuthoringDraftFromBinding(legacy).picks[0]?.side).toBe('CT');
    expect(bpAuthoringDraftFromBinding(legacyDecider).deciderSide).toBe('CT');
    expect(bpAuthoringDraftFromBinding(conflict).picks[0]?.side).toBeNull();
  });

  it('preserves the current binding on failed save and stores a successful local save in the LKG', async () => {
    const previous = await knownManifest();
    const onlineBinding = bindingFor(previous, 'online');
    const compiled = createLocalBpManifest(boundBo3Draft(previous), onlineBinding);
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const directory = await mkdtemp(join(tmpdir(), 'bp-local-test-'));
    try {
      const failedController = new MatchContextController({
        lkgStore: new MatchManifestLkgStore({
          filePath: join(directory, 'failed.json'),
          faultInjector: (point) => {
            if (point === 'before-write') throw new Error('injected local BP save failure');
          },
        }),
        initialBinding: onlineBinding,
      });
      const failedActiveBinding = failedController.getActiveBinding();
      const failed = await failedController.selectLocalMatch(
        compiled.manifest,
        failedController.getActiveRevision(),
      );
      expect(failed.ok).toBe(false);
      expect(failedController.getActiveBinding()).toBe(failedActiveBinding);

      const store = new MatchManifestLkgStore({ filePath: join(directory, 'match.json') });
      const controller = new MatchContextController({
        lkgStore: store,
        initialBinding: onlineBinding,
      });
      const saved = await controller.selectLocalMatch(
        compiled.manifest,
        controller.getActiveRevision(),
      );
      expect(saved.ok).toBe(true);
      expect(controller.getActiveBinding()?.origin).toBe('local');
      expect(controller.getActiveBinding()?.manifest.match.matchId).toBe(previous.match.matchId);
      expect(controller.getActiveBinding()?.manifest.match.competition.competitionId).toBe(
        previous.match.competition.competitionId,
      );
      expect(controller.getActiveBinding()?.manifest.entrants).toEqual(previous.entrants);
      expect(controller.getActiveBinding()?.manifest.commentators).toEqual(previous.commentators);
      expect(controller.getActiveBinding()?.manifest.maps[0]).toEqual(previous.maps[0]);
      const restored = await store.readLatest();
      expect(restored).toMatchObject({
        ok: true,
        value: { origin: 'cache', cachedFrom: 'local', manifest: { match: { format: 'bo3' } } },
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('keeps a bound overlay locked after save and cache restore', async () => {
    const previous = await knownManifest();
    const incompleteOnline = { ...previous, veto: [] };
    const onlineBinding = bindingFor(incompleteOnline, 'online');
    const compiled = createLocalBpManifest(boundBo3Draft(incompleteOnline), onlineBinding);
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;

    const directory = await mkdtemp(join(tmpdir(), 'bp-bound-provenance-test-'));
    try {
      const store = new MatchManifestLkgStore({ filePath: join(directory, 'match.json') });
      const controller = new MatchContextController({
        lkgStore: store,
        initialBinding: onlineBinding,
      });
      const saved = await controller.selectLocalMatch(
        compiled.manifest,
        controller.getActiveRevision(),
      );
      expect(saved.ok).toBe(true);
      if (!saved.ok) return;
      const localBinding = controller.getActiveBinding()!;
      expect(localBinding.localAuthoringMode).toBe('bound-overlay');

      const editedDraft = {
        ...bpAuthoringDraftFromBinding(localBinding),
        competitionName: '本地补录赛事名称',
        stage: '本地补录阶段',
        entrants: {
          a: { name: '补录后的队名 A', logoUrl: null },
          b: { name: '补录后的队名 B', logoUrl: null },
        },
      };
      expect(createLocalBpManifest(editedDraft, localBinding)).toMatchObject({
        ok: false,
        code: 'bp_bound_identity_locked',
      });
      expect(createLocalBpManifest({ ...editedDraft, format: 'bo5' }, localBinding)).toMatchObject({
        ok: false,
        code: 'bp_bound_identity_locked',
      });

      const bypassedCompiler = {
        ...compiled.manifest,
        match: {
          ...compiled.manifest.match,
          competition: { ...compiled.manifest.match.competition, name: '伪造赛事名' },
        },
      };
      const rejected = await controller.selectLocalMatch(
        bypassedCompiler,
        controller.getActiveRevision(),
      );
      expect(rejected).toMatchObject({
        ok: false,
        diagnostics: [expect.objectContaining({ code: 'local_identity_mismatch' })],
      });

      const cached = await store.readLatest();
      expect(cached).toMatchObject({
        ok: true,
        value: { origin: 'cache', cachedFrom: 'local', localAuthoringMode: 'bound-overlay' },
      });
      if (!cached.ok) return;
      expect(
        createLocalBpManifest({ ...editedDraft, stage: '重启后改阶段' }, cached.value),
      ).toMatchObject({ ok: false, code: 'bp_bound_identity_locked' });
      expect(cached.value.manifest.entrants.a.roster).toEqual(previous.entrants.a.roster);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('allows standalone match edits while keeping IDs stable through cache restore', async () => {
    const initial = createLocalBpManifest(draftFor('bo3'));
    expect(initial.ok).toBe(true);
    if (!initial.ok) return;
    const directory = await mkdtemp(join(tmpdir(), 'bp-standalone-provenance-test-'));
    try {
      const store = new MatchManifestLkgStore({ filePath: join(directory, 'match.json') });
      const controller = new MatchContextController({ lkgStore: store });
      const saved = await controller.selectLocalMatch(
        initial.manifest,
        controller.getActiveRevision(),
      );
      expect(saved.ok).toBe(true);
      if (!saved.ok) return;
      const localBinding = controller.getActiveBinding()!;
      expect(localBinding.localAuthoringMode).toBe('standalone');
      const originalIds = {
        matchId: localBinding.manifest.match.matchId,
        competitionId: localBinding.manifest.match.competition.competitionId,
        a: localBinding.manifest.entrants.a.entryId,
        b: localBinding.manifest.entrants.b.entryId,
      };
      const editedDraft = {
        ...bpAuthoringDraftFromBinding(localBinding),
        competitionName: '本地赛事改名',
        stage: '本地阶段改名',
        entrants: {
          a: { name: '本地队伍 A', logoUrl: null },
          b: { name: '本地队伍 B', logoUrl: null },
        },
      };
      const edited = createLocalBpManifest(editedDraft, localBinding);
      expect(edited.ok).toBe(true);
      if (!edited.ok) return;
      expect(edited.manifest.match.matchId).toBe(originalIds.matchId);
      expect(edited.manifest.match.competition.competitionId).toBe(originalIds.competitionId);
      expect(edited.manifest.entrants.a.entryId).toBe(originalIds.a);
      expect(edited.manifest.entrants.b.entryId).toBe(originalIds.b);
      expect(edited.manifest.entrants.a.name).toBe('本地队伍 A');

      const savedEdit = await controller.selectLocalMatch(
        edited.manifest,
        controller.getActiveRevision(),
      );
      expect(savedEdit.ok).toBe(true);
      const cached = await store.readLatest();
      expect(cached).toMatchObject({
        ok: true,
        value: { localAuthoringMode: 'standalone', cachedFrom: 'local' },
      });
      if (!cached.ok) return;
      const afterRestart = createLocalBpManifest(
        { ...editedDraft, stage: '重启后继续编辑' },
        cached.value,
      );
      expect(afterRestart.ok).toBe(true);
      if (afterRestart.ok) expect(afterRestart.manifest.match.matchId).toBe(originalIds.matchId);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('stages a recovered online match until the operator explicitly switches back', async () => {
    const online = await knownManifest();
    const local = createLocalBpManifest(draftFor('bo3'));
    expect(local.ok).toBe(true);
    if (!local.ok) return;
    const directory = await mkdtemp(join(tmpdir(), 'bp-local-online-test-'));
    try {
      const controller = new MatchContextController({
        lkgStore: new MatchManifestLkgStore({ filePath: join(directory, 'match.json') }),
        initialBinding: bindingFor(local.manifest, 'local'),
      });
      const localBinding = controller.getActiveBinding();
      const staged = await controller.selectMatch(online.match.matchId, {
        kind: 'online',
        load: () => Promise.resolve(online),
      });
      expect(staged.ok).toBe(true);
      expect(controller.getActiveBinding()).toBe(localBinding);
      const pending = controller.getPendingOnlineCandidate();
      expect(pending?.binding.manifest.match.matchId).toBe(online.match.matchId);

      const switched = await controller.activatePendingOnlineMatch(
        controller.getActiveRevision(),
        pending!.revision,
      );
      expect(switched.ok).toBe(true);
      expect(controller.getActiveBinding()?.origin).toBe('online');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('lets the newer pending online selection win when an older load finishes late', async () => {
    const base = createLocalBpManifest(draftFor('bo3'));
    expect(base.ok).toBe(true);
    if (!base.ok) return;
    const online = await knownManifest();
    const older: BroadcastManifestV1 = {
      ...online,
      revision: 'revision-older',
      match: { ...online.match, matchId: 'match-m2-older' },
    };
    const newer: BroadcastManifestV1 = {
      ...online,
      revision: 'revision-newer',
      match: { ...online.match, matchId: 'match-m2-newer' },
    };
    const directory = await mkdtemp(join(tmpdir(), 'bp-local-race-test-'));
    try {
      const controller = new MatchContextController({
        lkgStore: new MatchManifestLkgStore({ filePath: join(directory, 'match.json') }),
        initialBinding: bindingFor(base.manifest, 'local'),
      });
      const olderLoad = deferred<unknown>();
      const olderSelection = controller.selectMatch('match-m2-older', {
        kind: 'online',
        load: () => olderLoad.promise,
      });
      const newerSelection = await controller.selectMatch('match-m2-newer', {
        kind: 'online',
        load: () => Promise.resolve(newer),
      });
      olderLoad.resolve(older);
      const olderResult = await olderSelection;
      const pending = controller.getPendingOnlineCandidate();

      expect(newerSelection.ok).toBe(true);
      expect(olderResult.ok).toBe(false);
      expect(pending?.binding.manifest.match.matchId).toBe('match-m2-newer');
      expect(controller.getActiveBinding()?.origin).toBe('local');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('keeps a valid pending candidate when a later refresh fails', async () => {
    const base = createLocalBpManifest(draftFor('bo3'));
    expect(base.ok).toBe(true);
    if (!base.ok) return;
    const first = await knownManifest();
    const second = { ...first, match: { ...first.match, matchId: 'match-m2-refresh-fail' } };
    const directory = await mkdtemp(join(tmpdir(), 'bp-candidate-refresh-fail-test-'));
    try {
      const controller = new MatchContextController({
        lkgStore: new MatchManifestLkgStore({ filePath: join(directory, 'match.json') }),
        initialBinding: bindingFor(base.manifest, 'local'),
      });
      const staged = await controller.selectMatch(first.match.matchId, {
        kind: 'online',
        load: () => Promise.resolve(first),
      });
      expect(staged.ok).toBe(true);
      const pendingBefore = controller.getPendingOnlineCandidate();
      const refresh = deferred<unknown>();
      const refreshResult = controller.selectMatch(second.match.matchId, {
        kind: 'online',
        load: () => refresh.promise,
      });
      expect(controller.getPendingOnlineCandidate()).toEqual(pendingBefore);
      refresh.reject(new SourceLoadError('offline'));
      const failedRefresh = await refreshResult;

      expect(failedRefresh.ok).toBe(false);
      expect(controller.getPendingOnlineCandidate()).toEqual(pendingBefore);
      expect(controller.getPendingOnlineCandidate()?.binding.manifest.match.matchId).toBe(
        first.match.matchId,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('keeps a pending candidate across failed and successful local BP saves', async () => {
    const base = createLocalBpManifest(draftFor('bo3'));
    expect(base.ok).toBe(true);
    if (!base.ok) return;
    const online = await knownManifest();
    const directory = await mkdtemp(join(tmpdir(), 'bp-candidate-local-save-test-'));
    let failWrites = true;
    try {
      const controller = new MatchContextController({
        lkgStore: new MatchManifestLkgStore({
          filePath: join(directory, 'match.json'),
          faultInjector: (point) => {
            if (failWrites && point === 'before-write') throw new Error('injected save failure');
          },
        }),
        initialBinding: bindingFor(base.manifest, 'local'),
      });
      const staged = await controller.selectMatch(online.match.matchId, {
        kind: 'online',
        load: () => Promise.resolve(online),
      });
      expect(staged.ok).toBe(true);
      const pendingBefore = controller.getPendingOnlineCandidate();
      const edited = createLocalBpManifest(
        { ...draftFor('bo3'), stage: '保存失败后仍可重试' },
        controller.getActiveBinding(),
      );
      expect(edited.ok).toBe(true);
      if (!edited.ok) return;
      const failedSave = await controller.selectLocalMatch(
        edited.manifest,
        controller.getActiveRevision(),
      );
      expect(failedSave.ok).toBe(false);
      expect(controller.getPendingOnlineCandidate()).toEqual(pendingBefore);

      failWrites = false;
      const retryDraft = createLocalBpManifest(
        { ...draftFor('bo3'), stage: '本地 BP 已保存' },
        controller.getActiveBinding(),
      );
      expect(retryDraft.ok).toBe(true);
      if (!retryDraft.ok) return;
      const saved = await controller.selectLocalMatch(
        retryDraft.manifest,
        controller.getActiveRevision(),
      );
      expect(saved.ok).toBe(true);
      expect(controller.getPendingOnlineCandidate()).toEqual(pendingBefore);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('atomically replaces an older pending candidate with a newer valid one', async () => {
    const base = createLocalBpManifest(draftFor('bo3'));
    expect(base.ok).toBe(true);
    if (!base.ok) return;
    const fixture = await knownManifest();
    const first = { ...fixture, match: { ...fixture.match, matchId: 'match-m2-first-valid' } };
    const second = { ...fixture, match: { ...fixture.match, matchId: 'match-m2-second-valid' } };
    const directory = await mkdtemp(join(tmpdir(), 'bp-candidate-replace-test-'));
    try {
      const controller = new MatchContextController({
        lkgStore: new MatchManifestLkgStore({ filePath: join(directory, 'match.json') }),
        initialBinding: bindingFor(base.manifest, 'local'),
      });
      await controller.selectMatch(first.match.matchId, {
        kind: 'online',
        load: () => Promise.resolve(first),
      });
      const pendingFirst = controller.getPendingOnlineCandidate();
      await controller.selectMatch(second.match.matchId, {
        kind: 'online',
        load: () => Promise.resolve(second),
      });
      const pendingSecond = controller.getPendingOnlineCandidate();

      expect(pendingFirst).toBeDefined();
      expect(pendingSecond?.revision).not.toBe(pendingFirst?.revision);
      expect(pendingSecond?.binding.manifest.match.matchId).toBe(second.match.matchId);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('preserves a pending candidate when a local BP save overlaps acquisition', async () => {
    const base = createLocalBpManifest(draftFor('bo3'));
    expect(base.ok).toBe(true);
    if (!base.ok) return;
    const online = await knownManifest();
    const directory = await mkdtemp(join(tmpdir(), 'bp-local-save-race-test-'));
    try {
      const controller = new MatchContextController({
        lkgStore: new MatchManifestLkgStore({ filePath: join(directory, 'match.json') }),
        initialBinding: bindingFor(base.manifest, 'local'),
      });
      const inFlight = deferred<unknown>();
      const acquisition = controller.selectMatch(online.match.matchId, {
        kind: 'online',
        load: () => inFlight.promise,
      });
      const revision = controller.getActiveRevision();
      const edited = createLocalBpManifest(
        { ...draftFor('bo3'), stage: '本地最新 BP' },
        controller.getActiveBinding(),
      );
      expect(edited.ok).toBe(true);
      if (!edited.ok) return;
      const saved = await controller.selectLocalMatch(edited.manifest, revision);
      inFlight.resolve(online);
      const acquired = await acquisition;

      expect(saved.ok).toBe(true);
      expect(acquired.ok).toBe(true);
      expect(controller.getActiveBinding()?.origin).toBe('local');
      expect(controller.getActiveBinding()?.context.stage).toBe('本地最新 BP');
      expect(controller.getPendingOnlineCandidate()?.binding.manifest.match.matchId).toBe(
        online.match.matchId,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('keeps a newer candidate when an activation races a later selection', async () => {
    const base = createLocalBpManifest(draftFor('bo3'));
    expect(base.ok).toBe(true);
    if (!base.ok) return;
    const fixture = await knownManifest();
    const first: BroadcastManifestV1 = {
      ...fixture,
      revision: 'revision-first',
      match: { ...fixture.match, matchId: 'match-m2-first' },
    };
    const newer: BroadcastManifestV1 = {
      ...fixture,
      revision: 'revision-newest',
      match: { ...fixture.match, matchId: 'match-m2-newest' },
    };
    const directory = await mkdtemp(join(tmpdir(), 'bp-local-activation-race-test-'));
    const saveStarted = deferred<void>();
    const releaseSave = deferred<void>();
    class GatedStore extends MatchManifestLkgStore {
      override async save(
        candidate: unknown,
        origin: 'online' | 'local' | 'fixture',
        options?: Parameters<MatchManifestLkgStore['save']>[2],
      ) {
        if (
          origin === 'online' &&
          (candidate as BroadcastManifestV1).match.matchId === first.match.matchId
        ) {
          saveStarted.resolve();
          await releaseSave.promise;
        }
        return super.save(candidate, origin, options);
      }
    }
    try {
      const controller = new MatchContextController({
        lkgStore: new GatedStore({ filePath: join(directory, 'match.json') }),
        initialBinding: bindingFor(base.manifest, 'local'),
      });
      await controller.selectMatch(first.match.matchId, {
        kind: 'online',
        load: () => Promise.resolve(first),
      });
      const firstPending = controller.getPendingOnlineCandidate();
      expect(firstPending).toBeDefined();
      const activation = controller.activatePendingOnlineMatch(
        controller.getActiveRevision(),
        firstPending!.revision,
      );
      await saveStarted.promise;
      const newerSelection = controller.selectMatch(newer.match.matchId, {
        kind: 'online',
        load: () => Promise.resolve(newer),
      });
      releaseSave.resolve();
      const activationResult = await activation;
      const newerResult = await newerSelection;

      expect(activationResult.ok).toBe(false);
      expect(newerResult.ok).toBe(true);
      expect(controller.getActiveBinding()?.origin).toBe('local');
      expect(controller.getPendingOnlineCandidate()?.binding.manifest.match.matchId).toBe(
        newer.match.matchId,
      );
    } finally {
      releaseSave.resolve();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
