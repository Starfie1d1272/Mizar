import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

import { programSnapshotSchema, type ProgramSnapshot } from '@mizar/protocol/program';
import { radarSnapshotSchema, type RadarSnapshot } from '@mizar/protocol/radar';
import { toMatchContext, type BroadcastManifestV1 } from '@mizar/rivalhub';
import {
  iterateCaptureFrames,
  replayCapture,
  verifyCapture,
  type ReplayEvent,
  type ReplayFaultPlanV1,
  type VerifiedCapture,
} from '@mizar/testkit';

import {
  createProductionReplayComposition,
  createDisabledReplayCstvSources,
} from '../../src/replay/production-replay-composition.js';
import type { createProjectionCoordinator } from '../../src/projections/projection-coordinator.js';
import type { createProgramRuntime } from '../../src/runtime/program-runtime.js';

export const REPOSITORY_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

export async function readReplayManifest(): Promise<BroadcastManifestV1> {
  return JSON.parse(
    await readFile(
      resolve(REPOSITORY_ROOT, 'packages/rivalhub/test/fixtures/broadcast-manifest-v1.valid.json'),
      'utf8',
    ),
  ) as BroadcastManifestV1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Build fixture-local MatchContext directly from the preserved GSI roster. */
export async function buildReplayManifestFromCapture(
  capture: VerifiedCapture,
  template: BroadcastManifestV1,
): Promise<BroadcastManifestV1> {
  const provenance = capture.manifest.provenance;
  const rosterCapture =
    provenance !== undefined &&
    'sourceCaptureId' in provenance &&
    provenance.sourceCaptureId === '20260914T060149Z-4cda66b7-recovered-match'
      ? await verifyCapture(resolve(REPOSITORY_ROOT, 'fixtures/gsi/acceptance/ancient-round-03'))
      : capture;
  // Side labels can lag at halftime; use the fixed round-three capture to bind names to Steam64.
  for await (const frame of iterateCaptureFrames(rosterCapture)) {
    const payload = frame.payload;
    const map = isRecord(payload.map) ? payload.map : undefined;
    const allPlayers = isRecord(payload.allplayers) ? payload.allplayers : undefined;
    if (map === undefined || allPlayers === undefined) continue;
    const ct = isRecord(map.team_ct) ? map.team_ct : undefined;
    const t = isRecord(map.team_t) ? map.team_t : undefined;
    if (typeof ct?.name !== 'string' || typeof t?.name !== 'string') continue;

    const teams = new Map<string, Array<{ steam64: string; displayName: string }>>();
    for (const [steam64, rawPlayer] of Object.entries(allPlayers)) {
      if (!/^\d{17}$/.test(steam64) || !isRecord(rawPlayer)) continue;
      if (typeof rawPlayer.name !== 'string' || typeof rawPlayer.team !== 'string') continue;
      const teamName = rawPlayer.team === 'CT' ? ct.name : rawPlayer.team === 'T' ? t.name : null;
      if (teamName === null) continue;
      const roster = teams.get(teamName) ?? [];
      roster.push({ steam64, displayName: rawPlayer.name });
      teams.set(teamName, roster);
    }
    if (teams.get(ct.name)?.length !== 5 || teams.get(t.name)?.length !== 5) continue;

    const updateEntrant = (entry: BroadcastManifestV1['entrants']['a'], name: string) => ({
      ...entry,
      name,
      logoUrl: null,
      roster: {
        ...entry.roster,
        players: (teams.get(name) ?? [])
          .sort((left, right) => left.steam64.localeCompare(right.steam64))
          .map((player) => ({
            playerId: `steam-${player.steam64}`,
            steam64: player.steam64,
            displayName: player.displayName,
            avatarUrl: null,
            isStarter: true,
          })),
      },
    });

    return {
      ...template,
      entrants: {
        a: updateEntrant(template.entrants.a, ct.name),
        b: updateEntrant(template.entrants.b, t.name),
      },
    };
  }
  throw new Error(`Capture has no complete real Steam64 roster: ${capture.manifest.captureId}`);
}

async function applyFixturePresentationEnrichment(
  capture: VerifiedCapture,
  manifest: BroadcastManifestV1,
): Promise<BroadcastManifestV1> {
  const provenance = capture.manifest.provenance;
  if (
    provenance === undefined ||
    !('sourceCaptureId' in provenance) ||
    provenance.sourceCaptureId !== '20260914T060149Z-4cda66b7-recovered-match'
  )
    return manifest;

  const fixtureDirectory = resolve(REPOSITORY_ROOT, 'fixtures/gsi/acceptance/ancient-round-03');
  const [steamText, teamsText] = await Promise.all([
    readFile(resolve(fixtureDirectory, 'steam-enrichment.json'), 'utf8'),
    readFile(resolve(fixtureDirectory, 'team-context-enrichment.json'), 'utf8'),
  ]);
  const steamValue: unknown = JSON.parse(steamText) as unknown;
  const teamsValue: unknown = JSON.parse(teamsText) as unknown;
  const hasMatchingSource = (value: unknown): boolean => {
    if (!isRecord(value) || !isRecord(value.source)) return false;
    return (
      value.source.captureId === provenance.sourceCaptureId &&
      value.source.sourceFramesSha256 === provenance.sourceFramesSha256
    );
  };
  if (!hasMatchingSource(steamValue) || !hasMatchingSource(teamsValue))
    throw new Error(
      'Fixture presentation enrichment provenance does not match the replay capture.',
    );
  if (
    !isRecord(steamValue) ||
    !Array.isArray(steamValue.players) ||
    !isRecord(teamsValue) ||
    !Array.isArray(teamsValue.teams)
  )
    throw new Error('Fixture presentation enrichment has an invalid structure.');

  const avatars = new Map<string, string>();
  for (const candidate of steamValue.players as unknown[]) {
    if (!isRecord(candidate) || typeof candidate.steam64 !== 'string') continue;
    if (!isRecord(candidate.avatar)) continue;
    const avatar = candidate.avatar;
    if (
      typeof avatar.publicUrl !== 'string' ||
      typeof avatar.assetPath !== 'string' ||
      typeof avatar.sha256 !== 'string'
    )
      continue;
    const bytes = await readFile(resolve(REPOSITORY_ROOT, avatar.assetPath));
    const actualHash = createHash('sha256').update(bytes).digest('hex');
    if (actualHash !== avatar.sha256) throw new Error('Fixture Steam avatar hash mismatch.');
    avatars.set(candidate.steam64, avatar.publicUrl);
  }

  const logos = new Map<string, string>();
  for (const candidate of teamsValue.teams as unknown[]) {
    if (!isRecord(candidate)) continue;
    if (
      typeof candidate.gsiTeamName !== 'string' ||
      typeof candidate.logoUrl !== 'string' ||
      typeof candidate.assetPath !== 'string' ||
      typeof candidate.sha256 !== 'string'
    )
      continue;
    const bytes = await readFile(resolve(REPOSITORY_ROOT, candidate.assetPath));
    const actualHash = createHash('sha256').update(bytes).digest('hex');
    if (actualHash !== candidate.sha256) throw new Error('Fixture team logo hash mismatch.');
    logos.set(candidate.gsiTeamName, candidate.logoUrl);
  }

  const enrichEntrant = (entrant: BroadcastManifestV1['entrants']['a']) => ({
    ...entrant,
    logoUrl: logos.get(entrant.name) ?? null,
    roster: {
      ...entrant.roster,
      players: entrant.roster.players.map((player) => ({
        ...player,
        avatarUrl: player.steam64 === null ? null : (avatars.get(player.steam64) ?? null),
      })),
    },
  });
  return {
    ...manifest,
    entrants: {
      a: enrichEntrant(manifest.entrants.a),
      b: enrichEntrant(manifest.entrants.b),
    },
  };
}

/** Tournament labels/plan are harness data; only current observation proves the side. */
export async function normalizeReplayManifest(
  capture: VerifiedCapture,
  manifest: BroadcastManifestV1,
): Promise<BroadcastManifestV1> {
  for await (const event of replayCapture(capture, { mode: { kind: 'step' } })) {
    if (event.kind !== 'frame') continue;
    if (!event.result.ok)
      throw new Error(`Capture adaptation failed: ${event.sourceFrame.sequence}`);
    const observation = event.result.observation;
    const players = observation.telemetry.allPlayers;
    if (observation.coverage.allPlayers !== 'present' || players?.length !== 10) continue;
    const roster = new Set(manifest.entrants.a.roster.players.map((player) => player.steam64));
    const teamA = players.filter((player) => roster.has(player.sourcePlayerId));
    const side = teamA[0]?.side;
    if (
      teamA.length !== 5 ||
      (side !== 'CT' && side !== 'T') ||
      !teamA.every((player) => player.side === side) ||
      players.filter((player) => player.side === side).length !== 5
    )
      continue;
    return {
      ...manifest,
      maps: manifest.maps.map((map) => ({
        ...map,
        scoreA: null,
        scoreB: null,
        completedAt: null,
        teamAStartSide:
          map.mapName === observation.telemetry.map?.name
            ? side === 'CT'
              ? 'ct'
              : 't'
            : map.teamAStartSide,
      })),
    };
  }
  throw new Error('Capture lacks an unambiguous complete 5v5 roster frame');
}

export interface RealReplayPipeline {
  readonly runtime: ReturnType<typeof createProgramRuntime>;
  readonly coordinator: ReturnType<typeof createProjectionCoordinator>;
}

/** Shared production composition for semantic fixtures and full-match fault replay. */
export async function replayRealProgram(options: {
  readonly configureManifest?: (manifest: BroadcastManifestV1) => BroadcastManifestV1;
  readonly capturePath: string;
  readonly targetSequence?: number;
  readonly faultPlan?: ReplayFaultPlanV1;
  readonly onStart?: (pipeline: RealReplayPipeline) => void;
  readonly beforeEvent?: (event: ReplayEvent, pipeline: RealReplayPipeline) => void;
  readonly afterEvent?: (event: ReplayEvent, pipeline: RealReplayPipeline) => void;
}): Promise<{
  readonly snapshot: ProgramSnapshot;
  readonly radarSnapshot: RadarSnapshot;
  readonly runtimeSnapshot: ReturnType<RealReplayPipeline['runtime']['getSnapshot']>;
  readonly capture: VerifiedCapture;
  readonly manifest: BroadcastManifestV1;
  readonly acceptedSequences: readonly number[];
}> {
  const capture = await verifyCapture(options.capturePath);
  const sourceManifest = await buildReplayManifestFromCapture(capture, await readReplayManifest());
  const enrichedManifest = await applyFixturePresentationEnrichment(capture, sourceManifest);
  const normalizedManifest = await normalizeReplayManifest(capture, enrichedManifest);
  const manifest = options.configureManifest?.(normalizedManifest) ?? normalizedManifest;
  const context = toMatchContext(manifest);
  const composition = createProductionReplayComposition({
    producerInstanceId: 'real-program-replay',
    context,
    cstvSources: createDisabledReplayCstvSources(),
    matchContextBinding: {
      manifest,
      context,
      origin: 'fixture',
      freshness: 'fresh',
      diagnostics: [],
    },
  });
  const pipeline = { runtime: composition.runtime, coordinator: composition.coordinator };
  const acceptedSequences: number[] = [];
  try {
    options.onStart?.(pipeline);
    for await (const event of replayCapture(capture, {
      mode: { kind: 'step' },
      ...(options.faultPlan === undefined ? {} : { faultPlan: options.faultPlan }),
    })) {
      options.beforeEvent?.(event, pipeline);
      if (event.kind === 'frame' && event.result.ok)
        await composition.coordinator.prepareBombDamageMap(
          event.result.observation.telemetry.map?.name ?? null,
        );
      const snapshots = composition.accept(event);
      if (event.kind === 'frame' && snapshots !== null) {
        acceptedSequences.push(event.sourceFrame.sequence);
      }
      options.afterEvent?.(event, pipeline);
      if (event.kind === 'frame' && event.sourceFrame.sequence === options.targetSequence) break;
    }
    if (
      options.targetSequence !== undefined &&
      !acceptedSequences.includes(options.targetSequence)
    ) {
      throw new Error(`Target sequence not found: ${options.targetSequence}`);
    }
    return {
      capture,
      manifest,
      acceptedSequences,
      snapshot: programSnapshotSchema.parse(
        composition.coordinator.getPublisher('program').getCurrent(),
      ),
      radarSnapshot: radarSnapshotSchema.parse(
        composition.coordinator.getPublisher('radar').getCurrent(),
      ),
      runtimeSnapshot: composition.runtime.getSnapshot(),
    };
  } finally {
    await composition.close();
  }
}
