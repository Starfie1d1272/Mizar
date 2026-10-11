import type { ProgramSnapshot } from '@mizar/protocol/program';
import type { RadarSnapshot } from '@mizar/protocol/radar';
import { getProgramFixture } from './program-fixtures';
import {
  NUKE_LOWER_WORLD_ANCHORS,
  NUKE_UPPER_WORLD_ANCHORS,
  radarVisualFixture,
} from './radar-fixtures';
import {
  DEFAULT_HUD_COMPOSITE_FIXTURES,
  type DefaultHudCompositeFixture,
} from './default-hud-composite-ids';

export { DEFAULT_HUD_COMPOSITE_FIXTURES };
export type { DefaultHudCompositeFixture };

export interface DefaultHudCompositeSnapshot {
  readonly id: DefaultHudCompositeFixture;
  readonly snapshot: ProgramSnapshot;
  readonly radarSnapshot: RadarSnapshot;
  readonly provenance: 'synthetic-presentation' | 'synthetic-edge';
}

const SOURCES: Record<DefaultHudCompositeFixture, string> = {
  'default-live-5v5': 'live-canonical',
  'default-avatar-present': 'live-canonical',
  'default-avatar-missing': 'live-canonical',
  'default-freezetime': 'player-rails-freezetime',
  'default-observed': 'player-rails-dead-observed',
  'default-dead': 'player-rails-dead-observed',
  'default-low-hp': 'live-canonical',
  'default-planted': 'real-planted',
  'default-critical': 'real-planted',
  'default-defusing': 'real-defusing',
  'default-timeout': 'series-timeout-a',
  'default-tech-pause': 'real-paused',
  'default-halftime': 'series-halftime-swap',
  'default-nuke-multifloor': 'live-canonical',
  'default-missing-logo': 'series-logo-mixed',
  'default-stage-playin-10': 'live-canonical',
  'default-stage-playin-00': 'live-canonical',
  'default-stage-bo3': 'live-canonical',
  'default-stage-semifinal': 'live-canonical',
  'default-stage-third-place': 'live-canonical',
  'default-stage-grand-final': 'live-canonical',
  'default-stage-long': 'live-canonical',
  'default-stage-unknown': 'live-canonical',
  'default-stage-local-missing': 'live-neutral',
};

function sourceSnapshot(id: DefaultHudCompositeFixture): ProgramSnapshot {
  const snapshot = getProgramFixture(SOURCES[id]);
  if (snapshot === null) throw new Error(`Default HUD source fixture is missing: ${SOURCES[id]}`);
  return structuredClone(snapshot);
}

function mutateProgram(id: DefaultHudCompositeFixture, snapshot: ProgramSnapshot): void {
  // Visual discussion only: the website supplies stageLabel, not pre-match records.
  // Shared records here are explicit synthetic preview copy, never inferred from map/series scores.
  const stagePreview: Partial<Record<DefaultHudCompositeFixture, string | null>> = {
    'default-stage-playin-10': 'PLAY-IN · 1–0',
    'default-stage-playin-00': 'PLAY-IN · 0–0',
    'default-stage-bo3': 'PLAY-IN · 1–0',
    'default-stage-semifinal': '半决赛',
    'default-stage-third-place': '季军赛',
    'default-stage-grand-final': '总决赛',
    'default-stage-long':
      '全国高校电子竞技联赛秋季邀请赛华东赛区公开组资格选拔阶段最终晋级附加赛特别加赛暨全国总决赛资格争夺最终晋级特别邀请挑战赛',
    'default-stage-unknown': '周末社区挑战赛',
    'default-stage-local-missing': null,
  };
  if (Object.hasOwn(stagePreview, id)) {
    if (id === 'default-stage-local-missing') {
      snapshot.payload.match = null;
      snapshot.payload.series = null;
    } else if (snapshot.payload.match) {
      snapshot.payload.match.stage = stagePreview[id]!;
    }
    if (id === 'default-stage-playin-00') snapshot.payload.map.score = { ct: 0, t: 0 };
    if (id === 'default-stage-long' && snapshot.payload.series) {
      snapshot.payload.series.entrants.a.name = '南京航空航天大学电子竞技代表队';
      snapshot.payload.series.entrants.b.name = '华东理工大学电子竞技联合代表队';
    }
    if (id === 'default-stage-bo3' && snapshot.payload.series) {
      const series = snapshot.payload.series;
      series.score = { a: 1, b: 0 };
      series.currentMapOrder = 2;
      series.maps[0]!.status = 'completed';
      series.maps[0]!.finalScore = { a: 13, b: 8 };
      series.maps[0]!.winnerEntryId = series.entrants.a.entryId;
      series.maps[1]!.status = 'current';
      snapshot.payload.map.name = series.maps[1]!.mapName;
    }
  }
  if (id === 'default-avatar-missing') {
    snapshot.payload.players.forEach((player) => {
      player.avatarUrl = null;
    });
  }
  if (id === 'default-observed' || id === 'default-low-hp') {
    const player = snapshot.payload.players.find(
      (candidate) => candidate.sourcePlayerId === snapshot.payload.observedPlayerSourceId,
    );
    if (player?.state) player.state.roundKills = 2;
  }
  if (id === 'default-low-hp') {
    const player = snapshot.payload.players.find(
      (candidate) => candidate.lifeState === 'alive' && candidate.state !== null,
    );
    if (player?.state) player.state.health = 20;
  }
  if (id === 'default-critical') {
    const explosion = snapshot.payload.bomb?.explosion;
    if (explosion) explosion.remainingSeconds = 8;
  }
  if (id === 'default-nuke-multifloor') {
    snapshot.payload.map.name = 'de_nuke';
  }
  if (id === 'default-missing-logo' && snapshot.payload.series !== null) {
    snapshot.payload.series.entrants.a.logoUrl = null;
    snapshot.payload.series.entrants.b.logoUrl = null;
  }
}

export function getDefaultHudCompositeFixture(id: string): DefaultHudCompositeSnapshot | null {
  if (!DEFAULT_HUD_COMPOSITE_FIXTURES.includes(id as DefaultHudCompositeFixture)) return null;
  const fixtureId = id as DefaultHudCompositeFixture;
  const snapshot = sourceSnapshot(fixtureId);
  mutateProgram(fixtureId, snapshot);
  const radarId =
    fixtureId === 'default-nuke-multifloor'
      ? 'nuke-upper'
      : snapshot.payload.map.name === 'de_vertigo'
        ? 'vertigo-lower'
        : 'focused';
  const radarSnapshot = structuredClone(radarVisualFixture(radarId).snapshot);
  if (fixtureId === 'default-nuke-multifloor') {
    radarSnapshot.payload.players.forEach((player, index) => {
      const lower = index >= 5;
      const anchorIndex = lower ? (index - 5) * 2 + 1 : index * 2;
      const anchor = lower
        ? NUKE_LOWER_WORLD_ANCHORS[anchorIndex]!
        : NUKE_UPPER_WORLD_ANCHORS[anchorIndex]!;
      player.position = { ...anchor, z: lower ? -600 : 0 };
    });
  }
  return {
    id: fixtureId,
    snapshot,
    radarSnapshot,
    provenance:
      fixtureId === 'default-avatar-present' ||
      fixtureId === 'default-freezetime' ||
      fixtureId === 'default-observed' ||
      fixtureId === 'default-dead' ||
      fixtureId === 'default-low-hp' ||
      fixtureId === 'default-critical' ||
      fixtureId === 'default-nuke-multifloor' ||
      fixtureId === 'default-missing-logo'
        ? 'synthetic-edge'
        : 'synthetic-presentation',
  };
}
