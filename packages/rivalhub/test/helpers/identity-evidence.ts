import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import type { MatchContext } from '@mizar/core/match-context';
import { iterateCaptureFrames, verifyCapture } from '@mizar/testkit';

import { toMatchContext, type BroadcastManifest } from '../../src/index.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function manifestFromCapture(
  capturePath: string,
  template: BroadcastManifest,
): Promise<BroadcastManifest> {
  const capture = await verifyCapture(capturePath);
  for await (const frame of iterateCaptureFrames(capture)) {
    const map = isRecord(frame.payload.map) ? frame.payload.map : undefined;
    const allPlayers = isRecord(frame.payload.allplayers) ? frame.payload.allplayers : undefined;
    const ct = map !== undefined && isRecord(map.team_ct) ? map.team_ct : undefined;
    const t = map !== undefined && isRecord(map.team_t) ? map.team_t : undefined;
    if (allPlayers === undefined || typeof ct?.name !== 'string' || typeof t?.name !== 'string')
      continue;

    const playersByTeam = new Map<string, Array<{ steam64: string; displayName: string }>>([
      [ct.name, []],
      [t.name, []],
    ]);
    for (const [steam64, player] of Object.entries(allPlayers)) {
      if (!/^\d{17}$/.test(steam64) || !isRecord(player) || typeof player.name !== 'string')
        continue;
      const teamName = player.team === 'CT' ? ct.name : player.team === 'T' ? t.name : undefined;
      if (teamName === undefined) continue;
      playersByTeam.get(teamName)?.push({ steam64, displayName: player.name });
    }
    if (playersByTeam.get(ct.name)?.length !== 5 || playersByTeam.get(t.name)?.length !== 5)
      continue;

    const entrant = (source: BroadcastManifest['entrants']['a'], name: string) => ({
      ...source,
      name,
      logoUrl: null,
      roster: {
        ...source.roster,
        players: (playersByTeam.get(name) ?? [])
          .sort((left, right) => left.steam64.localeCompare(right.steam64))
          .map(({ steam64, displayName }) => ({
            playerId: `steam-${steam64}`,
            steam64,
            displayName,
            avatarUrl: null,
            isStarter: true,
          })),
      },
    });

    return {
      ...template,
      entrants: {
        a: entrant(template.entrants.a, ct.name),
        b: entrant(template.entrants.b, t.name),
      },
    };
  }
  throw new Error(`真实 capture 缺少完整 Steam64 阵容：${capture.manifest.captureId}`);
}

export async function contextFromCapture(capturePath: string): Promise<MatchContext> {
  const sourceCapture = await verifyCapture(capturePath);
  const provenance = sourceCapture.manifest.provenance;
  const identityCapturePath =
    provenance !== undefined &&
    'sourceCaptureId' in provenance &&
    provenance.sourceCaptureId === '20260914T060149Z-4cda66b7-recovered-match'
      ? resolve(process.cwd(), 'fixtures/gsi/acceptance/ancient-round-03')
      : capturePath;
  const template = JSON.parse(
    await readFile(
      resolve(process.cwd(), 'packages/rivalhub/test/fixtures/broadcast-manifest-v1.valid.json'),
      'utf8',
    ),
  ) as BroadcastManifest;
  return toMatchContext(await manifestFromCapture(identityCapturePath, template));
}
