import { matchResultIssue } from './match-result.js';
import { z } from 'zod';
import { localBo3BpRulesSchema } from './bp.js';

export const MATCH_DOCUMENT_SCHEMA_VERSION = 'mizar.match-document.v1' as const;
export const SCHEDULE_WINDOW_SCHEMA_VERSION = 'mizar.schedule-window.v1' as const;

const id = z.string().trim().min(1).max(128);
const label = z.string().trim().max(256);
const optionalLabel = label.nullable();
const instant = z.iso.datetime({ offset: true }).nullable();
const count = z.number().int().min(0).max(999).nullable();
const asset = z
  .string()
  .max(2048)
  .refine((value) => {
    if (value.startsWith('/') && !value.startsWith('//'))
      return !value
        .split('')
        .some(
          (character) =>
            character === '\\' || character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
        );
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && url.username === '' && url.password === '';
    } catch {
      return false;
    }
  })
  .nullable();
/** External viewing links are distinct from downloadable/rendered assets. */
export const liveStreamUrlSchema = z
  .string()
  .max(2048)
  .refine((value) => {
    if (
      value
        .split('')
        .some(
          (character) =>
            character === '\\' || character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127,
        )
    )
      return false;
    try {
      const url = new URL(value);
      return (
        (url.protocol === 'http:' || url.protocol === 'https:') &&
        url.username === '' &&
        url.password === ''
      );
    } catch {
      return false;
    }
  })
  .nullable();
const format = z.enum(['bo1', 'bo3', 'bo5']);
const status = z.enum(['scheduled', 'in_progress', 'finished', 'cancelled']);
const side = z.enum(['CT', 'T']).nullable();

const competition = z.strictObject({
  competitionId: id,
  name: label.min(1),
  logoUrl: asset,
  themeColor: label.nullable(),
});
const entrantSummary = z.strictObject({ entryId: id, name: label.min(1), logoUrl: asset });
export const matchPlayerV1Schema = z.strictObject({
  playerId: id,
  steam64: z
    .string()
    .regex(/^\d{17}$/)
    .nullable(),
  displayName: optionalLabel,
  avatarUrl: asset,
  isStarter: z.boolean(),
});
const entrant = entrantSummary.extend({
  rosterId: id.nullable(),
  players: z.array(matchPlayerV1Schema).max(32),
});
const map = z.strictObject({
  mapId: id,
  mapOrder: z.number().int().min(1).max(5),
  mapName: label.min(1),
  pickedByEntryId: id.nullable(),
  teamAStartSide: side,
  scoreA: count,
  scoreB: count,
  completedAt: instant,
});
const veto = z.strictObject({
  stepOrder: z.number().int().min(1).max(32),
  actionType: z.enum(['ban', 'pick', 'side_pick', 'decider']),
  mapName: label.min(1),
  entryId: id.nullable(),
  side,
});

export const matchDocumentV1Schema = z
  .strictObject({
    schemaVersion: z.literal(MATCH_DOCUMENT_SCHEMA_VERSION),
    matchId: id,
    competition: competition.nullable(),
    status,
    format,
    stage: label.min(1).nullable(),
    stageLabel: label.min(1),
    round: z.number().int().min(0).max(99).nullable(),
    roundLabel: optionalLabel,
    entryRound: optionalLabel,
    matchLabel: optionalLabel,
    stakesLabel: optionalLabel,
    scheduledAt: instant,
    startedAt: instant,
    completedAt: instant,
    scoreA: count,
    scoreB: count,
    resultDisposition: z.enum(['recorded', 'pending', 'omitted']).nullable().default(null),
    isForfeit: z.boolean(),
    isTest: z.boolean().default(false),
    entrants: z.strictObject({ a: entrant, b: entrant }),
    mapPool: z.array(label.min(1)).max(16),
    maps: z.array(map).max(5),
    veto: z.array(veto).max(32),
    commentators: z
      .array(
        z.strictObject({
          userId: id,
          displayName: label,
          avatarUrl: asset,
          liveStreamUrl: liveStreamUrlSchema,
        }),
      )
      .max(16),
  })
  .superRefine((document, ctx) => {
    const issue = matchResultIssue(document, document.maps);
    if (issue) ctx.addIssue({ code: 'custom', message: issue, path: ['resultDisposition'] });
    if (document.entrants.a.entryId === document.entrants.b.entryId)
      ctx.addIssue({ code: 'custom', message: 'entrants must differ', path: ['entrants'] });
    if (new Set(document.mapPool).size !== document.mapPool.length)
      ctx.addIssue({ code: 'custom', message: 'duplicate map pool entry', path: ['mapPool'] });
    if (new Set(document.maps.map((item) => item.mapOrder)).size !== document.maps.length)
      ctx.addIssue({ code: 'custom', message: 'duplicate map order', path: ['maps'] });
    if (new Set(document.veto.map((item) => item.stepOrder)).size !== document.veto.length)
      ctx.addIssue({ code: 'custom', message: 'duplicate veto order', path: ['veto'] });
    const entries = new Set([document.entrants.a.entryId, document.entrants.b.entryId]);
    if (
      document.maps.some(
        (item) => item.pickedByEntryId !== null && !entries.has(item.pickedByEntryId),
      ) ||
      document.veto.some((item) => item.entryId !== null && !entries.has(item.entryId))
    )
      ctx.addIssue({ code: 'custom', message: 'unknown entrant', path: ['maps'] });
  });

const scheduleMatch = z.strictObject({
  matchId: id,
  scheduledAt: instant,
  startedAt: instant,
  completedAt: instant,
  status,
  format,
  stage: label.min(1),
  stageLabel: label.min(1),
  round: z.number().int().min(0).max(99).nullable(),
  roundLabel: optionalLabel,
  matchLabel: optionalLabel,
  isForfeit: z.boolean(),
  isTest: z.boolean().default(false),
  scoreA: count,
  scoreB: count,
  entrants: z.strictObject({ a: entrantSummary, b: entrantSummary }),
});
export const scheduleWindowV1Schema = z
  .strictObject({
    schemaVersion: z.literal(SCHEDULE_WINDOW_SCHEMA_VERSION),
    competition,
    from: instant,
    to: instant,
    matches: z.array(scheduleMatch).max(256),
  })
  .superRefine((window, ctx) => {
    if (window.from !== null && window.to !== null && window.from > window.to)
      ctx.addIssue({ code: 'custom', message: 'invalid window', path: ['to'] });
    if (new Set(window.matches.map((match) => match.matchId)).size !== window.matches.length)
      ctx.addIssue({ code: 'custom', message: 'duplicate match', path: ['matches'] });
  });

export type MatchDocumentV1 = z.infer<typeof matchDocumentV1Schema>;
export type ScheduleWindowV1 = z.infer<typeof scheduleWindowV1Schema>;

function boundedParse<T>(schema: z.ZodType<T>, input: unknown, maxBytes: number): T {
  const serialized = JSON.stringify(input);
  if (serialized === undefined || new TextEncoder().encode(serialized).length > maxBytes)
    throw new Error('context_payload_too_large');
  return schema.parse(input);
}

export const parseMatchDocumentV1 = (input: unknown): MatchDocumentV1 =>
  boundedParse(matchDocumentV1Schema, input, 131_072);
export const parseScheduleWindowV1 = (input: unknown): ScheduleWindowV1 =>
  boundedParse(scheduleWindowV1Schema, input, 262_144);

/** Companion durable Local asset shape; referential invariants are enforced by its store. */
export const localTournamentStateV1Schema = z.strictObject({
  version: z.literal('mizar.local-tournament-store.v1'),
  events: z
    .array(
      z.strictObject({
        eventId: id,
        name: label.min(1),
        logoUrl: asset,
        themeColor: optionalLabel,
        mapPool: z.array(label.min(1)).max(16),
        bo3Rules: localBo3BpRulesSchema.optional(),
        matchIds: z.array(id).max(256),
      }),
    )
    .max(32),
  teams: z
    .array(
      z.strictObject({
        teamId: id,
        name: label.min(1),
        logoUrl: asset,
        players: z.array(matchPlayerV1Schema).max(32),
      }),
    )
    .max(128),
  matches: z.array(matchDocumentV1Schema).max(256),
  trashedMatches: z
    .array(
      z.strictObject({
        document: matchDocumentV1Schema,
        deletedAt: instant,
        scheduleIndex: z.number().int().min(0).nullable(),
        scheduleMatchIds: z.array(id).max(256).default([]),
      }),
    )
    .max(256)
    .default([]),
  selectedMatchId: id.nullable(),
  selectedAt: instant,
});

export { matchResultIssue } from './match-result.js';
