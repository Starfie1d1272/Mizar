import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { format } from 'prettier';
import { localDocumentBindingManifest } from '../../src/match-context/local-document-adapter.js';
import { sameReplayCursor } from '../../src/replay/production-replay-composition.js';
import { replayRealProgram, REPOSITORY_ROOT } from '../support/real-program-replay.js';

export const EPL_PROGRAM_MATRIX = [
  ['epl-live', 'inferno-opening', 600],
  ['epl-freeze', 'inferno-freeze', 1450],
  ['epl-timeout', 'inferno-timeout', 1482],
  ['epl-halftime', 'inferno-halftime', 1495],
  ['epl-planting', 'inferno-final-round', 2250],
  ['epl-planted', 'inferno-final-round', 2300],
  ['epl-defusing', 'inferno-final-round', 3070],
  ['epl-map-result', 'inferno-final-round', 3140],
  ['epl-match-result', 'mirage-final-round', 12090],
] as const;

export async function generateEplProgramFixtures() {
  const media = JSON.parse(
    await readFile(resolve(REPOSITORY_ROOT, 'fixtures/epl-s24/media.json'), 'utf8'),
  ) as { assets: { path: string; sha256: string }[] };
  for (const asset of media.assets) {
    if (!/^apps\/web\/public\/fixture-media\/epl-s24\/7656119\d{10}\.jpg$/.test(asset.path))
      throw new Error('Invalid EPL media path');
    const bytes = await readFile(resolve(REPOSITORY_ROOT, asset.path));
    if (createHash('sha256').update(bytes).digest('hex') !== asset.sha256)
      throw new Error(`EPL media hash mismatch: ${asset.path}`);
  }
  const document = JSON.parse(
    await readFile(resolve(REPOSITORY_ROOT, 'fixtures/epl-s24/match-document.json'), 'utf8'),
  ) as unknown;
  const manifest = localDocumentBindingManifest(document);
  const source = JSON.parse(
    await readFile(resolve(REPOSITORY_ROOT, 'fixtures/epl-s24/source.json'), 'utf8'),
  ) as { matches: { matchId: string; maps: { name: string; score: [number, number] | null }[] }[] };
  const match = source.matches.find((entry) => entry.matchId === manifest.match.matchId);
  if (!match) throw new Error('Missing EPL public match source');
  const fixtures = {} as Record<string, unknown>;
  for (const [id, name, targetSequence] of EPL_PROGRAM_MATRIX) {
    const capturePath = `fixtures/epl-s24/captures/${name}`;
    const result = await replayRealProgram({
      capturePath: resolve(REPOSITORY_ROOT, capturePath),
      targetSequence,
      configureManifest: () =>
        name.startsWith('mirage-')
          ? {
              ...manifest,
              maps: manifest.maps.map((map) => {
                const recorded = match.maps.find((entry) => entry.name === map.mapName);
                return map.mapOrder < 3 && recorded?.score
                  ? { ...map, scoreA: recorded.score[0], scoreB: recorded.score[1] }
                  : map;
              }),
            }
          : manifest,
    });
    const p = result.capture.manifest.provenance;
    if (!p || !('fixtureKind' in p) || p.fixtureKind !== 'sanitized-real-capture')
      throw new Error(`Missing sanitized capture provenance: ${id}`);
    if (!sameReplayCursor(result.snapshot.cursor, result.radarSnapshot.cursor))
      throw new Error(`Program/radar cursor mismatch: ${id}`);
    if (
      result.snapshot.payload.match?.matchId !== 'hltv-2398745' ||
      result.snapshot.payload.players.length !== 10
    )
      throw new Error(`EPL identity was not resolved by production replay: ${id}`);
    fixtures[id] = {
      provenance: { ...p, capturePath, targetSequence },
      snapshot: result.snapshot,
      radarSnapshot: result.radarSnapshot,
    };
  }
  return { schemaVersion: 1, fixtures };
}

export async function runEplGenerator(mode: '--write' | '--check') {
  const artifact = await generateEplProgramFixtures();
  const bytes = await format(JSON.stringify(artifact), { parser: 'json', printWidth: 100 });
  const output = resolve(
    REPOSITORY_ROOT,
    'apps/web/src/program/fixtures/generated/epl-program-fixtures.generated.json',
  );
  if (mode === '--write') await writeFile(output, bytes);
  else if ((await readFile(output, 'utf8')) !== bytes) throw new Error('EPL fixture drift');
  console.log(`${mode}: ${EPL_PROGRAM_MATRIX.length} EPL Program/radar fixtures`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const mode = process.argv[2];
  if (mode !== '--write' && mode !== '--check') throw new Error('Usage: --write | --check');
  await runEplGenerator(mode);
}
