import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  createIdentityResolver,
  resolveIdentity,
  type IdentityResolution,
} from '@mizar/core/identity';
import type { MatchContext } from '@mizar/core/match-context';
import type { ObservedPlayer } from '@mizar/core/telemetry';
import { describe, expect, it } from 'vitest';

import { toMatchContext, type BroadcastManifestV1 } from '../src/index.js';

const fixtureRoot = resolve(process.cwd(), 'packages/rivalhub/test/fixtures');

async function readManifest(): Promise<BroadcastManifestV1> {
  return JSON.parse(
    await readFile(resolve(fixtureRoot, 'broadcast-manifest-v1.valid.json'), 'utf8'),
  ) as BroadcastManifestV1;
}

function canonicalPlayers(context: MatchContext) {
  return [
    ...context.entrants.a.players.map((player) => ({
      ...player,
      entryId: context.entrants.a.entryId,
    })),
    ...context.entrants.b.players.map((player) => ({
      ...player,
      entryId: context.entrants.b.entryId,
    })),
  ];
}

function observedPlayers(
  context: MatchContext,
  options: {
    readonly sideA?: 'CT' | 'T';
    readonly sideB?: 'CT' | 'T';
    readonly includeSubstitute?: boolean;
    readonly replaceStarter?: boolean;
    readonly ignoreStarterFlags?: boolean;
    readonly count?: number;
    readonly nicknameSuffix?: string;
    readonly slotOffset?: number;
  } = {},
): ObservedPlayer[] {
  const sideA = options.sideA ?? 'CT';
  const sideB = options.sideB ?? 'T';
  const canonical = canonicalPlayers(context);
  const active = canonical.filter(
    (player) => player.isStarter || options.includeSubstitute === true,
  );
  let selected =
    options.ignoreStarterFlags === true
      ? [
          ...canonical
            .filter((player) => player.entryId === context.entrants.a.entryId)
            .slice(0, 5),
          ...canonical
            .filter((player) => player.entryId === context.entrants.b.entryId)
            .slice(0, 5),
        ]
      : active.slice(0, options.count ?? 10);
  if (options.replaceStarter === true) {
    const starters = active.filter((player) => player.isStarter);
    const substitute = active.find((player) => !player.isStarter);
    if (substitute === undefined) throw new Error('fixture must contain a substitute');
    selected = [...starters.slice(1), substitute];
  }
  return selected.map((player, index) => {
    if (player.steam64 === null) throw new Error('identity fixture player must have Steam64');
    return {
      sourcePlayerId: player.steam64,
      displayName: `游戏昵称-${options.nicknameSuffix ?? '初始'}-${index}`,
      observerSlot: (options.slotOffset ?? 0) + index + 1,
      side: player.entryId === context.entrants.a.entryId ? sideA : sideB,
    };
  });
}

function evidence(
  players: readonly ObservedPlayer[] | undefined,
  overrides: {
    readonly sourceGeneration?: number;
    readonly mapEpoch?: number;
    readonly allPlayersCoverage?: 'present' | 'absent' | 'degraded';
    readonly mapName?: string;
    readonly mapPhase?: 'warmup' | 'live' | 'intermission' | 'gameover' | 'unknown';
    readonly mapSideNames?: { readonly ct?: string; readonly t?: string };
  } = {},
) {
  return {
    sourceGeneration: overrides.sourceGeneration ?? 1,
    mapEpoch: overrides.mapEpoch ?? 1,
    ...(players === undefined ? {} : { allPlayers: players }),
    allPlayersCoverage:
      overrides.allPlayersCoverage ?? (players === undefined ? 'absent' : 'present'),
    ...(overrides.mapName === undefined ? {} : { mapName: overrides.mapName }),
    ...(overrides.mapPhase === undefined ? {} : { mapPhase: overrides.mapPhase }),
    ...(overrides.mapSideNames === undefined ? {} : { mapSideNames: overrides.mapSideNames }),
  } as const;
}

function issueCodes(resolution: IdentityResolution): string[] {
  return resolution.issues.map((entry) => entry.code);
}

describe('Steam64 identity resolver and dynamic side mapping', () => {
  it('matches a complete 10-player lineup by Steam64 and entryId', async () => {
    const context = toMatchContext(await readManifest());
    const resolution = resolveIdentity(
      context,
      evidence(observedPlayers(context), { mapName: 'de_ancient', mapPhase: 'live' }),
    );

    expect(resolution.state).toBe('matched');
    expect(resolution.players).toHaveLength(10);
    expect(resolution.unresolved).toHaveLength(0);
    expect(resolution.sideMapping).toEqual({ a: 'CT', b: 'T' });
    expect(resolution.capabilities).toEqual({
      canonicalPlayerMapping: true,
      canonicalTeamBranding: true,
      identityDependentResult: true,
      neutralTelemetry: true,
    });
  });

  it('updates only side mapping when halftime or overtime swaps CT/T', async () => {
    const context = toMatchContext(await readManifest());
    const before = resolveIdentity(context, evidence(observedPlayers(context)));
    const after = resolveIdentity(
      context,
      evidence(observedPlayers(context, { sideA: 'T', sideB: 'CT' })),
      before,
    );

    expect(before.state).toBe('matched');
    expect(after.state).toBe('matched');
    expect(after.sideMapping).toEqual({ a: 'T', b: 'CT' });
    expect(after.players.map((player) => player.canonicalPlayerId)).toEqual(
      before.players.map((player) => player.canonicalPlayerId),
    );
  });

  it('lets Steam64-resolved player side proof win a conflicting map name fallback', async () => {
    const context = toMatchContext(await readManifest());
    const resolution = resolveIdentity(
      context,
      evidence(observedPlayers(context, { sideA: 'T', sideB: 'CT' }), {
        mapSideNames: {
          ct: context.entrants.a.name,
          t: context.entrants.b.name,
        },
      }),
    );

    expect(resolution.state).toBe('matched');
    expect(resolution.sideMapping).toEqual({ a: 'T', b: 'CT' });
    expect(issueCodes(resolution)).toContain('side_mapping_conflict');
    expect(resolution.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'side_mapping_conflict',
          entryId: context.entrants.a.entryId,
          observedSide: 'T',
          mapSide: 'CT',
        }),
      ]),
    );
  });

  it('ignores nickname and observer-slot changes for identity matching', async () => {
    const context = toMatchContext(await readManifest());
    const before = resolveIdentity(context, evidence(observedPlayers(context)));
    const after = resolveIdentity(
      context,
      evidence(observedPlayers(context, { nicknameSuffix: '改名', slotOffset: 20 })),
      before,
    );

    expect(after.state).toBe('matched');
    expect(after.players.map((player) => player.canonicalPlayerId)).toEqual(
      before.players.map((player) => player.canonicalPlayerId),
    );
  });

  it('keeps a legal ten-player replacement matched and emits lineup_differs_from_expected', async () => {
    const context = toMatchContext(await readManifest());
    const resolution = resolveIdentity(
      context,
      evidence(observedPlayers(context, { includeSubstitute: true, replaceStarter: true }), {
        mapName: 'de_ancient',
      }),
    );

    expect(resolution.state).toBe('matched');
    expect(resolution.players).toHaveLength(10);
    expect(resolution.unresolved).toHaveLength(0);
    expect(issueCodes(resolution)).toEqual(['lineup_differs_from_expected']);
  });

  it('does not use nine starter flags to authorize a valid ten-player lineup', async () => {
    const context = toMatchContext(await readManifest());
    const nineStarterContext: MatchContext = {
      ...context,
      entrants: {
        ...context.entrants,
        a: {
          ...context.entrants.a,
          players: context.entrants.a.players.map((player, index) =>
            index === 0 ? { ...player, isStarter: false } : player,
          ),
        },
      },
    };
    const resolution = resolveIdentity(
      nineStarterContext,
      evidence(observedPlayers(context, { ignoreStarterFlags: true })),
    );

    expect(resolution.state).toBe('matched');
    expect(resolution.players).toHaveLength(10);
    expect(issueCodes(resolution)).toEqual(['lineup_differs_from_expected']);
  });

  it('does not use eleven starter flags to reject a valid ten-player lineup', async () => {
    const context = toMatchContext(await readManifest());
    const elevenStarterContext: MatchContext = {
      ...context,
      entrants: {
        ...context.entrants,
        a: {
          ...context.entrants.a,
          players: context.entrants.a.players.map((player, index) =>
            index === context.entrants.a.players.length - 1
              ? { ...player, isStarter: true }
              : player,
          ),
        },
      },
    };
    const resolution = resolveIdentity(
      elevenStarterContext,
      evidence(observedPlayers(context, { ignoreStarterFlags: true })),
    );

    expect(resolution.state).toBe('matched');
    expect(resolution.players).toHaveLength(10);
    expect(issueCodes(resolution)).toEqual(['lineup_differs_from_expected']);
  });

  it('requires at least five canonical roster members on each side', async () => {
    const context = toMatchContext(await readManifest());
    const incompleteContext: MatchContext = {
      ...context,
      entrants: {
        ...context.entrants,
        a: {
          ...context.entrants.a,
          players: context.entrants.a.players.slice(0, 4),
        },
      },
    };
    const resolution = resolveIdentity(
      incompleteContext,
      evidence(observedPlayers(context, { ignoreStarterFlags: true })),
    );

    expect(resolution.state).toBe('degraded');
    expect(issueCodes(resolution)).toContain('roster_incomplete');
  });

  it('treats a partial lineup as degraded while preserving the mapped players', async () => {
    const context = toMatchContext(await readManifest());
    const resolution = resolveIdentity(context, evidence(observedPlayers(context, { count: 9 })));

    expect(resolution.state).toBe('degraded');
    expect(resolution.players).toHaveLength(9);
    expect(issueCodes(resolution)).toContain('partial_roster_evidence');
  });

  it('keeps matched identity and branding on isolated absent or degraded allplayers frames', async () => {
    const context = toMatchContext(await readManifest());
    const resolver = createIdentityResolver(context);
    const matched = resolver.resolve(evidence(observedPlayers(context)));
    const absent = resolver.resolve(evidence(undefined, { allPlayersCoverage: 'absent' }));
    const degradedAbsent = resolver.resolve(
      evidence(undefined, { allPlayersCoverage: 'degraded' }),
    );
    const degraded = resolver.resolve(
      evidence(observedPlayers(context), { allPlayersCoverage: 'degraded' }),
    );

    expect(matched.state).toBe('matched');
    expect(absent.state).toBe('matched');
    expect(absent.players).toHaveLength(10);
    expect(absent.capabilities.canonicalTeamBranding).toBe(true);
    expect(absent.players.every((player) => player.evidence === 'retained')).toBe(true);
    expect(degradedAbsent.state).toBe('matched');
    expect(degradedAbsent.capabilities.canonicalTeamBranding).toBe(true);
    expect(issueCodes(degradedAbsent)).toContain('allplayers_degraded');
    expect(degraded.state).toBe('matched');
    expect(degraded.players).toHaveLength(10);
    expect(degraded.capabilities.canonicalTeamBranding).toBe(true);
    expect(issueCodes(degraded)).toContain('allplayers_degraded');
  });

  it('deduplicates a duplicate observed Steam64 without revoking the previous proof', async () => {
    const context = toMatchContext(await readManifest());
    const resolver = createIdentityResolver(context);
    const matched = resolver.resolve(evidence(observedPlayers(context)));
    const duplicate = observedPlayers(context);
    duplicate[0] = { ...duplicate[0]!, sourcePlayerId: duplicate[1]!.sourcePlayerId };

    const resolution = resolver.resolve(evidence(duplicate, { allPlayersCoverage: 'degraded' }));

    expect(matched.state).toBe('matched');
    expect(resolution.state).toBe('matched');
    expect(issueCodes(resolution)).toContain('duplicate_observed_identity');
    expect(resolution.capabilities.canonicalTeamBranding).toBe(true);
  });

  it('does not reuse old proof across source generation or map epoch baselines', async () => {
    const context = toMatchContext(await readManifest());
    const matched = resolveIdentity(context, evidence(observedPlayers(context)));
    const newGeneration = resolveIdentity(
      context,
      evidence(undefined, { sourceGeneration: 2 }),
      matched,
    );
    const newMap = resolveIdentity(context, evidence(undefined, { mapEpoch: 2 }), matched);

    expect(newGeneration.state).toBe('resolving');
    expect(newGeneration.players).toHaveLength(0);
    expect(issueCodes(newGeneration)).toContain('source_generation_changed');
    expect(newMap.state).toBe('resolving');
    expect(newMap.players).toHaveLength(0);
    expect(issueCodes(newMap)).toContain('map_epoch_changed');
  });

  it('degrades for an unexpected or duplicated Steam64 while keeping neutral telemetry', async () => {
    const context = toMatchContext(await readManifest());
    const unexpected = observedPlayers(context);
    unexpected[0] = { ...unexpected[0]!, sourcePlayerId: '76561198000000099' };
    const mismatch = resolveIdentity(context, evidence(unexpected));
    const duplicate = resolveIdentity(
      context,
      evidence([...observedPlayers(context), observedPlayers(context)[0]!]),
    );

    expect(mismatch.state).toBe('degraded');
    expect(mismatch.capabilities.canonicalTeamBranding).toBe(true);
    expect(mismatch.capabilities.identityDependentResult).toBe(false);
    expect(mismatch.capabilities.neutralTelemetry).toBe(true);
    expect(issueCodes(mismatch)).toContain('unexpected_human_steam64');
    expect(duplicate.state).toBe('degraded');
    expect(issueCodes(duplicate)).toContain('duplicate_observed_identity');
  });

  it('does not guess BOT/non-Steam64 identities and handles missing canonical Steam64 locally', async () => {
    const context = toMatchContext(await readManifest());
    const withBot = observedPlayers(context);
    withBot[0] = { ...withBot[0]!, sourcePlayerId: 'BOT-001' };
    const degraded = resolveIdentity(context, evidence(withBot));
    const incompleteContext: MatchContext = {
      ...context,
      entrants: {
        ...context.entrants,
        a: {
          ...context.entrants.a,
          players: context.entrants.a.players.map((player, index) =>
            index === 0 ? { ...player, steam64: null } : player,
          ),
        },
      },
    };
    const missingCanonical = resolveIdentity(incompleteContext, evidence(observedPlayers(context)));

    expect(degraded.state).toBe('degraded');
    expect(degraded.players).toHaveLength(9);
    expect(issueCodes(degraded)).toContain('bot_or_noncanonical_source_id');
    expect(missingCanonical.state).toBe('degraded');
    expect(issueCodes(missingCanonical)).toContain('missing_canonical_steam64');
  });

  it('only marks a wrong live map as mismatch after gameplay evidence is explicit', async () => {
    const context = toMatchContext(await readManifest());
    const warmup = resolveIdentity(
      context,
      evidence(observedPlayers(context), { mapName: 'de_wrong', mapPhase: 'warmup' }),
    );
    const live = resolveIdentity(
      context,
      evidence(observedPlayers(context), { mapName: 'de_wrong', mapPhase: 'live' }),
    );

    expect(warmup.state).toBe('matched');
    expect(issueCodes(warmup)).toContain('map_not_confirmed');
    expect(live.state).toBe('mismatch');
    expect(issueCodes(live)).toContain('map_mismatch');
  });

  it('does not treat an incomplete canonical BO3 map list as proof of a wrong live map', async () => {
    const context = toMatchContext(await readManifest());
    const partialMapContext: MatchContext = {
      ...context,
      maps: context.maps.slice(0, 1),
    };
    const resolution = resolveIdentity(
      partialMapContext,
      evidence(observedPlayers(context), { mapName: 'de_mirage', mapPhase: 'live' }),
    );

    expect(resolution.state).toBe('matched');
    expect(issueCodes(resolution)).toContain('map_not_confirmed');
    expect(issueCodes(resolution)).not.toContain('map_mismatch');
  });

  it('starts unbound and can be rebound without carrying prior identity proof', async () => {
    const context = toMatchContext(await readManifest());
    const resolver = createIdentityResolver();
    expect(resolver.getResolution().state).toBe('unbound');
    expect(resolver.bind(context).state).toBe('resolving');
    expect(
      resolver.resolve(evidence(observedPlayers(context), { mapName: 'de_ancient' })).state,
    ).toBe('matched');
  });
});
