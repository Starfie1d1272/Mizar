import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, URL } from 'node:url';

const { fetch, AbortSignal } = globalThis;

import {
  validateBroadcastManifest,
  validateBroadcastScheduleWindow,
} from '../../packages/rivalhub/dist/index.js';

const root = fileURLToPath(new URL('../..', import.meta.url));
const output = resolve(root, 'fixtures/rivals-rehearsal/rivals-rehearsal.generated.json');
const focusMatchId = 'd9987c41-180a-4113-8003-c6d18d1ba1e6';
const from = '2026-05-22T00:00:00.000Z';
const to = '2026-05-27T00:00:00.000Z';
const base = 'https://match.starfie1d.top';

function assertFixture(value) {
  if (value?.schemaVersion !== 'mizar.rivals-rehearsal.v1' || value.focusMatchId !== focusMatchId)
    throw new Error('Rivals 示例版本或焦点比赛不符。');
  const schedule = validateBroadcastScheduleWindow(value.schedule);
  const manifest = validateBroadcastManifest(value.manifests?.[focusMatchId]);
  if (!schedule.ok || !manifest.ok) throw new Error('Rivals 示例赛事资料未通过契约检查。');
  if (manifest.value.match.matchId !== focusMatchId || manifest.value.match.format !== 'bo3')
    throw new Error('Rivals 示例焦点比赛不符。');
  if (
    !schedule.value.matches.some((match) => match.matchId === focusMatchId) ||
    schedule.value.matches.length < 3
  )
    throw new Error('Rivals 示例缺少前后赛程。');
  if (
    Object.keys(value.manifests).length !== schedule.value.matches.length ||
    !schedule.value.matches.every((match) => {
      const checked = validateBroadcastManifest(value.manifests[match.matchId]);
      return (
        checked.ok &&
        checked.value.match.matchId === match.matchId &&
        checked.value.entrants.a.roster.players.filter((player) => player.isStarter).length === 5 &&
        checked.value.entrants.b.roster.players.filter((player) => player.isStarter).length === 5
      );
    })
  )
    throw new Error('Rivals 示例的相邻比赛资料或首发不完整。');
  if (
    manifest.value.maps.length !== 3 ||
    manifest.value.veto.length !== 7 ||
    manifest.value.match.scoreA !== 2 ||
    manifest.value.match.scoreB !== 1 ||
    manifest.value.entrants.a.roster.players.filter((player) => player.isStarter).length !== 5 ||
    manifest.value.entrants.b.roster.players.filter((player) => player.isStarter).length !== 5
  )
    throw new Error('Rivals 示例缺少完整 BO3、BP 或首发。');
  const forbidden = /"(?:email|qq|token|credential|adminRole|studentId)"\s*:/i;
  if (forbidden.test(JSON.stringify(value))) throw new Error('Rivals 示例包含不允许公开的字段。');
  if (
    value.provenance?.gameplaySource !== 'fixtures/gsi/acceptance/ancient-round-03' ||
    !String(value.provenance.gameplayRelationship).includes('Independent')
  )
    throw new Error('Gameplay 来源说明缺失。');
}

async function request(path, token) {
  const response = await fetch(new URL(path, base), {
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`RivalHub 公开资料读取失败：HTTP ${response.status}`);
  return response.json();
}

if (process.argv.includes('--check')) {
  const raw = await readFile(output, 'utf8');
  const value = JSON.parse(raw);
  assertFixture(value);
  if (raw !== `${JSON.stringify(value, null, 2)}\n`) throw new Error('Rivals 示例格式不稳定。');
  process.stdout.write('Rivals 示例已验证。\n');
} else {
  const token = process.env.RIVALHUB_REHEARSAL_TOKEN;
  if (!token) throw new Error('同步前请设置 RIVALHUB_REHEARSAL_TOKEN。');
  const schedule = await request(
    `/api/mizar/schedule?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    token,
  );
  const ordered = [...schedule.matches].sort(
    (a, b) =>
      (a.scheduledAt ?? '').localeCompare(b.scheduledAt ?? '') ||
      a.matchId.localeCompare(b.matchId),
  );
  const index = ordered.findIndex((match) => match.matchId === focusMatchId);
  if (index < 0) throw new Error('RivalHub 赛程中没有焦点比赛。');
  const matches = ordered.slice(Math.max(0, index - 2), index + 3);
  const manifests = Object.fromEntries(
    await Promise.all(
      matches.map(async (match) => [
        match.matchId,
        await request(`/api/mizar/match?matchId=${match.matchId}`, token),
      ]),
    ),
  );
  const focus = manifests[focusMatchId];
  const value = {
    schemaVersion: 'mizar.rivals-rehearsal.v1',
    focusMatchId,
    provenance: {
      competitionSource: 'RivalHub production public 2026 NJU Rivals snapshot',
      capturedAt: new Date().toISOString().slice(0, 10),
      gameplaySource: 'fixtures/gsi/acceptance/ancient-round-03',
      gameplayRelationship: 'Independent real CS2 GSI capture; not the focus match recording',
      missingLogoEntryId: focus.entrants.b.logoUrl === null ? focus.entrants.b.entryId : null,
    },
    schedule: { ...schedule, matches },
    manifests,
  };
  assertFixture(value);
  await writeFile(output, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  process.stdout.write('Rivals 示例已更新。\n');
}
