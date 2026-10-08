import { radarSnapshotSchema, type RadarSnapshot } from '@mizar/protocol/radar';
import type { ProgramSnapshot } from '@mizar/protocol/program';
import { getProgramFixtureReplaySource } from './program-fixtures.js';
import { eplFixture } from './epl-program-fixtures.js';
import artifact from './generated/real-radar-fixtures.generated.json' with { type: 'json' };

export const RADAR_VISUAL_FIXTURES = [
  'full-map',
  'dense-utility',
  'focused',
  'bomb-carried',
  'bomb-planted',
  'dead-flashed',
  'nuke-upper',
  'nuke-lower',
  'vertigo-lower',
  'auto',
  'small',
  'large',
  'stale',
  'unsupported',
] as const;
export type RadarVisualFixture = (typeof RADAR_VISUAL_FIXTURES)[number];

// Synthetic, explicitly placed Nuke positions sampled from traversable rooms
// across each pinned 1024px floor image and converted through the canonical
// CS2 calibration. They validate floor projection, not demo evidence.
export const NUKE_UPPER_WORLD_ANCHORS = [
  { x: -2333, y: -998 },
  { x: -1740, y: -949 },
  { x: -1073, y: -998 },
  { x: -478, y: -683 },
  { x: 47, y: 507 },
  { x: 432, y: -88 },
  { x: 782, y: -718 },
  { x: 1447, y: -403 },
  { x: 2377, y: -683 },
  { x: 3127, y: -858 },
] as const;

export const NUKE_LOWER_WORLD_ANCHORS = [
  { x: 131, y: -554 },
  { x: 489, y: -697 },
  { x: 848, y: -840 },
  { x: 561, y: -1270 },
  { x: 919, y: -1414 },
  { x: 1206, y: -1199 },
  { x: 776, y: -1772 },
  { x: 1350, y: -1701 },
  { x: 274, y: -1987 },
  { x: 1565, y: -2059 },
] as const;

export const VERTIGO_LOWER_WORLD_ANCHORS = [
  { x: -2431, y: 328 },
  { x: -2144, y: -81 },
  { x: -1734, y: 42 },
  { x: -1284, y: -286 },
  { x: -792, y: -204 },
  { x: -424, y: -655 },
  { x: -219, y: -1105 },
  { x: -915, y: -1187 },
  { x: -1734, y: -1105 },
  { x: -2267, y: -982 },
] as const;

export function realRadarSnapshot(): RadarSnapshot {
  return radarSnapshotSchema.parse(artifact.fixtures['dense-utility'].samples[0]!.snapshot);
}

export type RadarEditorPreviewScene =
  'dense-utility' | 'warmup' | 'bomb-dropped' | 'bomb-planted' | 'bomb-defusing';

export function radarEditorPreviewSnapshot(scene: RadarEditorPreviewScene): RadarSnapshot {
  const fixture =
    scene === 'bomb-planted'
      ? artifact.fixtures['bomb-plant']
      : scene === 'bomb-defusing'
        ? artifact.fixtures['bomb-defuse']
        : artifact.fixtures[scene];

  const sample =
    scene === 'bomb-planted'
      ? fixture.samples.find((candidate) => candidate.snapshot.payload.bomb?.state === 'planted')
      : scene === 'bomb-defusing'
        ? fixture.samples.find((candidate) => candidate.snapshot.payload.bomb?.state === 'defusing')
        : fixture.samples[0];

  if (sample === undefined) {
    throw new Error(`Radar editor preview scene is missing: ${scene}`);
  }
  return radarSnapshotSchema.parse(structuredClone(sample.snapshot));
}

function sameCursor(program: ProgramSnapshot['cursor'], radar: RadarSnapshot['cursor']): boolean {
  return (
    program.producerInstanceId === radar.producerInstanceId &&
    program.liveSessionId === radar.liveSessionId &&
    program.runtimeSeq === radar.runtimeSeq &&
    program.programSourceGeneration === radar.programSourceGeneration &&
    program.programReceiveSequence === radar.programReceiveSequence &&
    program.mapEpoch === radar.mapEpoch
  );
}

/** Return only the Radar projection derived from the exact Program replay frame. */
export function radarSnapshotForProgramFixture(id: string): RadarSnapshot | null {
  const epl = eplFixture(id);
  if (epl) return radarSnapshotSchema.parse(structuredClone(epl.radarSnapshot));
  const source = getProgramFixtureReplaySource(id);
  if (source === null) return null;

  const provenance = source.provenance;
  const radarFixture = Object.values(artifact.fixtures).find((candidate) => {
    const selection = candidate.provenance.source.sourceFrameSelection;
    return (
      candidate.provenance.capturePath === provenance.capturePath &&
      candidate.provenance.source.sourceCaptureId === provenance.sourceCaptureId &&
      candidate.provenance.source.sourceFramesSha256 === provenance.sourceFramesSha256 &&
      selection.kind === 'sequence-range' &&
      selection.firstSequence <= provenance.targetSequence &&
      selection.lastSequence >= provenance.targetSequence
    );
  });
  if (radarFixture === undefined) return null;

  const sample = radarFixture.samples.find(
    (candidate) =>
      candidate.snapshot.cursor.programReceiveSequence === provenance.targetSequence &&
      sameCursor(source.snapshot.cursor, candidate.snapshot.cursor),
  );
  return sample === undefined ? null : radarSnapshotSchema.parse(structuredClone(sample.snapshot));
}

export function radarVisualFixture(id: RadarVisualFixture) {
  let snapshot = realRadarSnapshot();
  let kind: 'real-derived' | 'synthetic-edge' = 'real-derived';
  let reason: string | null = null;
  const synthetic = (description: string) => {
    kind = 'synthetic-edge';
    reason = description;
  };
  if (id === 'bomb-planted')
    snapshot = radarSnapshotSchema.parse(
      artifact.fixtures['bomb-plant'].samples.find(
        (s) => s.snapshot.payload.bomb?.state === 'planted',
      )!.snapshot,
    );
  if (id === 'full-map') {
    synthetic('Isolate player readability from the real dense scene');
    snapshot.payload.grenades = [];
  }
  if (id === 'focused') {
    synthetic('Select a stable real player as focus');
    snapshot.payload.observedPlayerSourceId = snapshot.payload.players[0]!.sourcePlayerId;
  }
  if (id === 'bomb-carried') {
    synthetic('Carried C4 association');
    snapshot.payload.bomb = {
      state: 'carried',
      sourcePlayerId: snapshot.payload.players[0]!.sourcePlayerId,
      position: null,
    };
  }
  if (id === 'dead-flashed') {
    synthetic('Simultaneous dead and flash presentation');
    snapshot.payload.players[0]!.lifeState = 'dead';
    snapshot.payload.players[1]!.flashAmount = 255;
  }
  if (id.startsWith('nuke') || id.startsWith('vertigo')) {
    synthetic(
      id.startsWith('nuke')
        ? 'Calibrated Nuke overview anchors test map/floor alignment; they are not demo evidence'
        : 'Floor readability with controlled Vertigo coordinates; source capture is not a floor acceptance claim',
    );
    snapshot.payload.mapName = id.startsWith('nuke') ? 'de_nuke' : 'de_vertigo';
    snapshot.payload.grenades = [];
    snapshot.payload.bomb = null;
    snapshot.payload.observedPlayerSourceId = snapshot.payload.players[0]!.sourcePlayerId;
    if (id.startsWith('nuke')) {
      const anchors = id === 'nuke-lower' ? NUKE_LOWER_WORLD_ANCHORS : NUKE_UPPER_WORLD_ANCHORS;
      snapshot.payload.players.forEach((player, index) => {
        const anchor = anchors[index]!;
        player.position = { ...anchor, z: id === 'nuke-lower' ? -600 : 0 };
      });
    } else {
      snapshot.payload.players.forEach((player, index) => {
        const anchor = VERTIGO_LOWER_WORLD_ANCHORS[index]!;
        player.position = { ...anchor, z: 11600 };
      });
    }
  }
  if (id === 'stale') {
    synthetic('Fresh-to-stale safety surface');
    snapshot.payload.telemetryFreshness = 'stale';
  }
  if (id === 'unsupported') {
    synthetic('Unsupported calibration');
    snapshot.payload.mapName = 'de_unsupported';
  }
  return {
    snapshot,
    provenance: { kind, reason },
    size: id === 'small' ? 200 : id === 'large' ? 640 : 320,
    zoomMode: id === 'auto' ? ('auto' as const) : ('full-map' as const),
  };
}
