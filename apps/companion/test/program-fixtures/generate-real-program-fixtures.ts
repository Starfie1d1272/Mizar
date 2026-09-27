import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { format } from 'prettier';
import { iterateCaptureFrames } from '@mizar/testkit';

import { replayRealProgram, REPOSITORY_ROOT } from '../support/real-program-replay.js';

export const REAL_PROGRAM_MATRIX = [
  ['real-warmup', 'warmup/observer', 45],
  ['real-live-rich', 'observer/rich-live-state', 727],
  ['real-bomb-dropped', 'bomb/dropped', 260],
  ['real-planting', 'bomb/plant', 1016],
  ['real-planting-late', 'bomb/plant', 1027],
  ['real-planted', 'bomb/plant', 1029],
  ['real-defusing', 'bomb/defuse', 5523],
  ['real-defused', 'bomb/defuse', 5544],
  ['real-exploded', 'bomb/explode-reset', 1194],
  ['real-post-explosion-freezetime', 'bomb/explode-reset', 1214],
  ['real-paused', 'match/paused', 3605],
  ['real-timeout-ct', 'match/timeout-ct', 2109],
  ['real-timeout-t', 'match/timeout-t', 4489],
  ['real-halftime-before', 'match/halftime-side-switch', 6145],
  ['real-halftime-after', 'match/halftime-side-switch', 6147],
  ['real-overtime-entry', 'match/regulation-to-overtime', 13130],
  ['real-overtime-side-before', 'match/overtime-side-switch', 14461],
  ['real-overtime-side-after', 'match/overtime-side-switch', 14463],
  ['real-gameover', 'match/gameover', 16261],
] as const;

export const REAL_PROGRAM_ARTIFACT_PATH = resolve(
  REPOSITORY_ROOT,
  'apps/web/src/program/fixtures/generated/real-program-fixtures.generated.json',
);

async function generateFixture(
  [id, captureName, targetSequence]: (typeof REAL_PROGRAM_MATRIX)[number],
  includeVerification = false,
) {
  const capturePath = `fixtures/gsi/semantic/${captureName}`;
  const result = await replayRealProgram({
    capturePath: resolve(REPOSITORY_ROOT, capturePath),
    targetSequence,
  });
  const { capture, snapshot } = result;
  const provenance = capture.manifest.provenance;
  if (
    provenance === undefined ||
    !('fixtureKind' in provenance) ||
    provenance.fixtureKind !== 'sanitized-real-capture' ||
    provenance.sourceFrameSelection.kind !== 'sequence-range'
  ) {
    throw new Error(`Expected committed sanitized sequence-range capture: ${capturePath}`);
  }
  const fixture = {
    provenance: {
      kind: 'real-derived' as const,
      capturePath,
      sourceCaptureId: provenance.sourceCaptureId,
      sourceFramesSha256: provenance.sourceFramesSha256,
      targetSequence,
      firstSequence: provenance.sourceFrameSelection.firstSequence,
      lastSequence: provenance.sourceFrameSelection.lastSequence,
      sanitizerVersion: provenance.sanitizerVersion,
    },
    snapshot,
  };

  if (!includeVerification) return { fixture };

  const expectedSequences: number[] = [];
  for await (const frame of iterateCaptureFrames(capture))
    if (frame.sequence <= targetSequence) expectedSequences.push(frame.sequence);

  return {
    fixture,
    verification: {
      id,
      capturePath,
      targetSequence,
      provenance: {
        sourceCaptureId: provenance.sourceCaptureId,
        sourceFramesSha256: provenance.sourceFramesSha256,
        firstSequence: provenance.sourceFrameSelection.firstSequence,
        lastSequence: provenance.sourceFrameSelection.lastSequence,
        sanitizerVersion: provenance.sanitizerVersion,
      },
      acceptedSequences: result.acceptedSequences,
      expectedSequences,
      snapshot,
      mapStates: result.manifest.maps.map(({ scoreA, scoreB, completedAt }) => ({
        scoreA,
        scoreB,
        completedAt,
      })),
    },
  };
}

export async function generateRealProgramFixtureEvidence() {
  const fixtures: Record<string, Awaited<ReturnType<typeof generateFixture>>['fixture']> = {};
  const verification = [];
  for (const row of REAL_PROGRAM_MATRIX) {
    const generated = await generateFixture(row, true);
    fixtures[row[0]] = generated.fixture;
    if (!('verification' in generated)) throw new Error('Missing fixture verification evidence');
    verification.push(generated.verification);
  }
  return {
    artifact: { schemaVersion: 1 as const, fixtures },
    verification,
  };
}

export async function generateRealProgramFixtures() {
  const fixtures: Record<string, Awaited<ReturnType<typeof generateFixture>>['fixture']> = {};
  for (const row of REAL_PROGRAM_MATRIX) {
    const generated = await generateFixture(row);
    fixtures[row[0]] = generated.fixture;
  }
  return { schemaVersion: 1 as const, fixtures };
}

export async function serializeRealProgramFixtures(
  artifact: Awaited<ReturnType<typeof generateRealProgramFixtures>>,
) {
  return format(JSON.stringify(artifact), { parser: 'json', printWidth: 100, tabWidth: 2 });
}

export async function runGenerator(
  mode: '--write' | '--check',
  outputPath = REAL_PROGRAM_ARTIFACT_PATH,
) {
  const artifact = await generateRealProgramFixtures();
  const bytes = await serializeRealProgramFixtures(artifact);
  if (mode === '--write') {
    await mkdir(dirname(outputPath), { recursive: true });
    const temporaryPath = `${outputPath}.${process.pid}.tmp`;
    try {
      await writeFile(temporaryPath, bytes, { encoding: 'utf8', flag: 'wx' });
      await rename(temporaryPath, outputPath);
    } finally {
      await rm(temporaryPath, { force: true });
    }
  } else {
    const previous = await readFile(outputPath, 'utf8');
    if (previous !== bytes) {
      const old = JSON.parse(previous) as typeof artifact;
      const ids = new Set([...Object.keys(old.fixtures), ...Object.keys(artifact.fixtures)]);
      const drift = [...ids].filter(
        (id) => JSON.stringify(old.fixtures[id]) !== JSON.stringify(artifact.fixtures[id]),
      );
      throw new Error(
        `Program fixture drift: ${drift.length ? drift.join(', ') : 'artifact formatting/schemaVersion'}`,
      );
    }
  }
  console.log(`${mode}: ${REAL_PROGRAM_MATRIX.length} Program fixtures`);
  for (const [id, capture, sequence] of REAL_PROGRAM_MATRIX)
    console.log(`${id}: ${capture} @ ${sequence}`);
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const mode = process.argv[2];
  if (mode !== '--write' && mode !== '--check') throw new Error('Usage: --write | --check');
  await runGenerator(mode);
}
