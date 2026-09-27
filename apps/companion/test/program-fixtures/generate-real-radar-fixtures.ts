import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { format } from 'prettier';
import { radarSnapshotSchema, type RadarSnapshot } from '@mizar/protocol/radar';
import { replayRealProgram, REPOSITORY_ROOT } from '../support/real-program-replay.js';

export const RADAR_FIXTURE_PATH = resolve(
  REPOSITORY_ROOT,
  'apps/web/src/program/fixtures/generated/real-radar-fixtures.generated.json',
);
export const RADAR_CAPTURE_MATRIX = [
  ['dense-utility', 'observer/rich-live-state'],
  ['warmup', 'warmup/observer'],
  ['bomb-dropped', 'bomb/dropped'],
  ['bomb-plant', 'bomb/plant'],
  ['bomb-defuse', 'bomb/defuse'],
  ['bomb-explode-reset', 'bomb/explode-reset'],
  ['match-paused', 'match/paused'],
  ['timeout-ct', 'match/timeout-ct'],
  ['timeout-t', 'match/timeout-t'],
  ['halftime-side-switch', 'match/halftime-side-switch'],
  ['regulation-to-overtime', 'match/regulation-to-overtime'],
  ['overtime-side-switch', 'match/overtime-side-switch'],
  ['match-gameover', 'match/gameover'],
] as const;

export async function generateRealRadarFixtures() {
  const fixtures: Record<string, unknown> = {};
  for (const [id, name] of RADAR_CAPTURE_MATRIX) {
    const samples: { elapsedMs: number; snapshot: RadarSnapshot }[] = [];
    const capturePath = `fixtures/gsi/semantic/${name}`;
    const result = await replayRealProgram({
      capturePath: resolve(REPOSITORY_ROOT, capturePath),
      afterEvent(event, { coordinator }) {
        if (event.kind !== 'frame') return;
        samples.push({
          elapsedMs: event.scheduledElapsedUs / 1000,
          snapshot: radarSnapshotSchema.parse(coordinator.getPublisher('radar').getCurrent()),
        });
      },
    });
    fixtures[id] = {
      provenance: {
        kind: 'real-derived',
        capturePath,
        framesSha256: result.capture.manifest.framesSha256,
        source: result.capture.manifest.provenance,
      },
      samples,
    };
  }
  return { schemaVersion: 1, fixtures };
}
export async function runRadarGenerator(check: boolean) {
  const bytes = await format(JSON.stringify(await generateRealRadarFixtures()), {
    parser: 'json',
    printWidth: 100,
  });
  if (check) {
    if ((await readFile(RADAR_FIXTURE_PATH, 'utf8')) !== bytes)
      throw new Error('Radar fixtures drift; run fixtures:radar:generate');
  } else await writeFile(RADAR_FIXTURE_PATH, bytes);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await runRadarGenerator(process.argv.includes('--check'));
}
