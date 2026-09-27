import { programSnapshotSchema, type ProgramSnapshot } from '@mizar/protocol/program';
import artifact from './generated/real-program-fixtures.generated.json' with { type: 'json' };

export interface RealProgramProvenance {
  readonly kind: 'real-derived';
  readonly capturePath: string;
  readonly sourceCaptureId: string;
  readonly sourceFramesSha256: string;
  readonly targetSequence: number;
  readonly firstSequence: number;
  readonly lastSequence: number;
  readonly sanitizerVersion: 2;
}
export type RealProgramFixtureId = keyof typeof artifact.fixtures;

export function parseRealProgramArtifact(value: unknown): {
  schemaVersion: 1;
  fixtures: Record<string, { provenance: RealProgramProvenance; snapshot: ProgramSnapshot }>;
} {
  const object = (input: unknown, keys: readonly string[]): Record<string, unknown> => {
    if (
      input === null ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      Object.keys(input).sort().join() !== [...keys].sort().join()
    )
      throw new Error('Invalid Program fixture artifact shape');
    return input as Record<string, unknown>;
  };
  const root = object(value, ['schemaVersion', 'fixtures']);
  if (
    root.schemaVersion !== 1 ||
    !root.fixtures ||
    typeof root.fixtures !== 'object' ||
    Array.isArray(root.fixtures)
  )
    throw new Error('Invalid Program fixture artifact version/fixtures');
  const fixtures: Record<string, { provenance: RealProgramProvenance; snapshot: ProgramSnapshot }> =
    {};
  for (const [id, input] of Object.entries(root.fixtures)) {
    if (!/^real-[a-z0-9-]+$/.test(id)) throw new Error(`Invalid real fixture ID: ${id}`);
    const record = object(input, ['provenance', 'snapshot']);
    const p = object(record.provenance, [
      'kind',
      'capturePath',
      'sourceCaptureId',
      'sourceFramesSha256',
      'targetSequence',
      'firstSequence',
      'lastSequence',
      'sanitizerVersion',
    ]);
    if (
      p.kind !== 'real-derived' ||
      p.sanitizerVersion !== 2 ||
      typeof p.capturePath !== 'string' ||
      !/^fixtures\/gsi\/semantic\/[a-z0-9-]+\/[a-z0-9-]+$/.test(p.capturePath) ||
      typeof p.sourceCaptureId !== 'string' ||
      !p.sourceCaptureId.trim() ||
      typeof p.sourceFramesSha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(p.sourceFramesSha256) ||
      ![p.firstSequence, p.lastSequence, p.targetSequence].every(
        (n) => typeof n === 'number' && Number.isSafeInteger(n) && n > 0,
      ) ||
      (p.firstSequence as number) > (p.targetSequence as number) ||
      (p.targetSequence as number) > (p.lastSequence as number)
    )
      throw new Error(`Invalid provenance: ${id}`);
    fixtures[id] = {
      provenance: p as unknown as RealProgramProvenance,
      snapshot: programSnapshotSchema.parse(record.snapshot),
    };
  }
  return { schemaVersion: 1, fixtures };
}

export const realProgramFixtures = parseRealProgramArtifact(artifact).fixtures as Readonly<
  Record<
    RealProgramFixtureId,
    { readonly provenance: RealProgramProvenance; readonly snapshot: ProgramSnapshot }
  >
>;
