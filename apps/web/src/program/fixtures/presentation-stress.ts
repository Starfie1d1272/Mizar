import {
  programSnapshotSchema,
  type ProgramPayload,
  type ProgramSnapshot,
} from '@mizar/protocol/program';

type Series = NonNullable<ProgramPayload['series']>;
export interface PresentationStressPatch {
  readonly playerAvatars?: Readonly<Record<string, string | null>>;
  readonly playerNames?: Readonly<Record<string, string | null>>;
  readonly teamAName?: string;
  readonly teamBName?: string;
  readonly teamALogoUrl?: string | null;
  readonly teamBLogoUrl?: string | null;
  readonly competitionName?: string;
  readonly stage?: string;
  readonly series?: Pick<
    Series,
    | 'format'
    | 'requiredWins'
    | 'score'
    | 'status'
    | 'bindingState'
    | 'currentMapOrder'
    | 'maps'
    | 'veto'
  >;
}

/** Only presentation metadata is writable; gameplay facts remain the real base's values. */
export function derivePresentationStressFixture(
  base: ProgramSnapshot,
  patch: PresentationStressPatch,
): ProgramSnapshot {
  const allowed = [
    'playerNames',
    'playerAvatars',
    'teamAName',
    'teamBName',
    'teamALogoUrl',
    'teamBLogoUrl',
    'competitionName',
    'stage',
    'series',
  ];
  if (Object.keys(patch).some((key) => !allowed.includes(key)))
    throw new Error('Unsupported presentation patch');
  if (
    patch.series !== undefined &&
    Object.keys(patch.series).some(
      (key) =>
        ![
          'format',
          'requiredWins',
          'score',
          'status',
          'bindingState',
          'currentMapOrder',
          'maps',
          'veto',
        ].includes(key),
    )
  )
    throw new Error('Unsupported series presentation patch');
  const payload = base.payload;
  if (payload.series === null || payload.match === null)
    throw new Error('Presentation base needs resolved context');
  const entrants = {
    a: {
      ...payload.series.entrants.a,
      name: patch.teamAName ?? payload.series.entrants.a.name,
      logoUrl:
        patch.teamALogoUrl === undefined ? payload.series.entrants.a.logoUrl : patch.teamALogoUrl,
    },
    b: {
      ...payload.series.entrants.b,
      name: patch.teamBName ?? payload.series.entrants.b.name,
      logoUrl:
        patch.teamBLogoUrl === undefined ? payload.series.entrants.b.logoUrl : patch.teamBLogoUrl,
    },
  };
  const series = { ...payload.series, ...patch.series, entrants };
  const team = (side: 'ct' | 't') => {
    const original = payload.teams[side];
    const key =
      original.entryId === entrants.a.entryId
        ? 'a'
        : original.entryId === entrants.b.entryId
          ? 'b'
          : null;
    return key === null
      ? original
      : {
          ...original,
          name: entrants[key].name,
          logoUrl: entrants[key].logoUrl,
          seriesScore: series.score[key],
        };
  };
  const result = programSnapshotSchema.parse({
    ...base,
    payload: {
      ...payload,
      series,
      match: {
        ...payload.match,
        format: series.format,
        stage: patch.stage ?? payload.match.stage,
        competition: {
          ...payload.match.competition,
          name: patch.competitionName ?? payload.match.competition?.name,
        },
      },
      teams: { ct: team('ct'), t: team('t') },
      players: payload.players.map((player) => ({
        ...player,
        avatarUrl:
          patch.playerAvatars?.[player.sourcePlayerId] === undefined
            ? player.avatarUrl
            : patch.playerAvatars[player.sourcePlayerId],
        displayName: patch.playerNames?.[player.sourcePlayerId] ?? player.displayName,
      })),
    },
  });
  // Schema parsing must not silently strip injected fields from nested plan metadata.
  if (patch.series !== undefined)
    for (const key of Object.keys(patch.series) as (keyof NonNullable<
      PresentationStressPatch['series']
    >)[]) {
      if (JSON.stringify(result.payload.series?.[key]) !== JSON.stringify(patch.series[key]))
        throw new Error(`Invalid series presentation field: ${key}`);
    }
  return result;
}
