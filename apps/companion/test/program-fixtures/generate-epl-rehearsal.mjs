import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath, URL } from 'node:url';
import process from 'node:process';
import console from 'node:console';
import { resolve } from 'node:path';
import { validateBroadcastManifest, validateBroadcastScheduleWindow } from '@mizar/rivalhub';
import { localDocumentBindingManifest } from '../../src/match-context/local-document-adapter.ts';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const read = async (path) => JSON.parse(await readFile(resolve(root, path), 'utf8'));
const source = await read('fixtures/epl-s24/source.json');
const base = localDocumentBindingManifest(await read('fixtures/epl-s24/match-document.json'));
const competition = base.match.competition;
const entrants = (name) =>
  name === 'Falcons'
    ? base.entrants.a
    : name === 'Natus Vincere'
      ? base.entrants.b
      : {
          entryId: `epl-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
          name,
          logoUrl: null,
          roster: { rosterId: null, players: [] },
        };
const manifests = {};
const scheduleMatches = [];
for (const record of source.matches) {
  const focus = record.matchId === base.match.matchId;
  const a = entrants(record.teamA),
    b = entrants(record.teamB);
  const past = record.scheduledAt < base.match.scheduledAt;
  const finished = past || focus;
  const match = {
    ...base.match,
    matchId: record.matchId,
    status: finished ? 'finished' : 'scheduled',
    stageLabel: `瑞士轮 · 第 ${record.round} 轮 · ${record.entryRecord} 组`,
    round: record.round,
    entryRound: `${record.entryRecord} 组`,
    scheduledAt: record.scheduledAt,
    matchLabel: `${record.teamA} vs ${record.teamB}`,
    stakesLabel: record.stakes,
    scoreA: finished ? record.score[0] : null,
    scoreB: finished ? record.score[1] : null,
  };
  const manifest = {
    ...base,
    revision: `epl-rehearsal-${record.matchId}`,
    match,
    entrants: { a, b },
    maps: record.maps.map((map, index) => ({
      mapId: `${record.matchId}-${index + 1}`,
      mapOrder: index + 1,
      mapName: map.name,
      pickedByEntryId:
        map.pickedBy === record.teamA
          ? a.entryId
          : map.pickedBy === record.teamB
            ? b.entryId
            : null,
      teamAStartSide: focus ? (base.maps[index]?.teamAStartSide ?? null) : null,
      scoreA: finished ? (map.score?.[0] ?? null) : null,
      scoreB: finished ? (map.score?.[1] ?? null) : null,
      completedAt: null,
    })),
    veto: focus ? base.veto : [],
  };
  const checked = validateBroadcastManifest(manifest);
  if (!checked.ok) throw Error(`Invalid EPL rehearsal match: ${record.matchId}`);
  manifests[record.matchId] = checked.value;
  scheduleMatches.push({
    ...match,
    status: past ? 'finished' : 'scheduled',
    scoreA: past ? match.scoreA : null,
    scoreB: past ? match.scoreB : null,
    entrantA: { entryId: a.entryId, name: a.name, logoUrl: a.logoUrl },
    entrantB: { entryId: b.entryId, name: b.name, logoUrl: b.logoUrl },
  });
}
const schedule = {
  schemaVersion: 'rivalhub.broadcast-schedule-window.v1',
  revision: 'epl-rehearsal-v1',
  competition,
  from: '2026-10-06T00:00:00.000Z',
  to: '2026-10-08T00:00:00.000Z',
  matches: scheduleMatches,
};
if (!validateBroadcastScheduleWindow(schedule).ok) throw Error('Invalid EPL schedule');
const observations = {},
  captureSources = [];
for (const [stageIndex, capture, sequence] of [
  [3, 'inferno-opening', 600],
  [4, 'inferno-halftime', 1495],
  [11, 'mirage-final-round', 11500],
]) {
  const dir = `fixtures/epl-s24/captures/${capture}`;
  const manifest = await read(`${dir}/manifest.json`);
  const bytes = await readFile(resolve(root, dir, 'frames.jsonl'));
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== manifest.framesSha256) throw Error(`Capture hash mismatch: ${capture}`);
  const frame = bytes
    .toString('utf8')
    .trim()
    .split('\n')
    .map(JSON.parse)
    .find((frame) => frame.sequence === sequence);
  if (!frame) throw Error(`Missing frame: ${capture}/${sequence}`);
  observations[stageIndex] = frame.payload;
  captureSources.push({ stageIndex, capture: dir, sequence, sha256 });
}
const output = {
  schemaVersion: 'mizar.rehearsal.v2',
  focusMatchId: base.match.matchId,
  provenance: {
    competitionSource: 'fixtures/epl-s24/source.json',
    gameplaySource: 'fixtures/epl-s24/captures',
    gameplayRelationship: 'Same Falcons–NAVI series; each telemetry stage uses its recorded map',
    captureSources,
  },
  // Only stages supported by committed observations or sourced map results are offered.
  stageIndices: [0, 1, 2, 3, 4, 5, 6, 9, 10, 11, 13, 14],
  observations,
  schedule,
  manifests,
};
const target = resolve(root, 'fixtures/epl-s24/rehearsal.generated.json');
const bytes = JSON.stringify(output, null, 2) + '\n';
if (process.argv[2] === '--write') await writeFile(target, bytes);
else if (process.argv[2] === '--check') {
  if ((await readFile(target, 'utf8')) !== bytes) throw Error('EPL rehearsal drift');
} else throw Error('Usage: --write | --check');
console.log(
  `${process.argv[2]}: ${scheduleMatches.length} EPL matches; ${captureSources.length} recorded telemetry stages`,
);
