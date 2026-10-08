import { programSnapshotSchema } from '@mizar/protocol/program';
import { radarSnapshotSchema } from '@mizar/protocol/radar';
import type { RealProgramProvenance } from './real-program-fixtures.js';
import artifact from './generated/epl-program-fixtures.generated.json' with { type: 'json' };

export type EplFixtureId = keyof typeof artifact.fixtures;
const parse = (record: (typeof artifact.fixtures)[EplFixtureId]) => {
  const source = record.provenance;
  const provenance: RealProgramProvenance = {
    kind: 'real-derived',
    capturePath: source.capturePath,
    sourceCaptureId: source.sourceCaptureId,
    sourceFramesSha256: source.sourceFramesSha256,
    targetSequence: source.targetSequence,
    firstSequence: source.sourceFrameSelection.firstSequence,
    lastSequence: source.sourceFrameSelection.lastSequence,
    sanitizerVersion: 2,
  };
  return {
    provenance,
    snapshot: programSnapshotSchema.parse(record.snapshot),
    radarSnapshot: radarSnapshotSchema.parse(record.radarSnapshot),
  };
};
export const eplProgramFixtures = Object.fromEntries(
  Object.entries(artifact.fixtures).map(([id, record]) => [id, parse(record)]),
) as Record<EplFixtureId, ReturnType<typeof parse>>;

export function eplFixture(id: string) {
  return Object.prototype.hasOwnProperty.call(eplProgramFixtures, id)
    ? eplProgramFixtures[id as EplFixtureId]
    : null;
}
