import { z } from 'zod';
import { programPayloadSchema } from './program.js';
import { projectionCursorSchema } from './shared.js';

/** One ordered registry shared by the operator, Program hosts and OBS reconciliation. */
export const PROGRAM_SCENES = [
  { id: 'waiting', title: '赛前等待', path: '/program/waiting', mode: 'full_screen_graphic' },
  { id: 'matchup', title: '对阵', path: '/program/matchup', mode: 'gameplay_overlay' },
  { id: 'bp', title: 'BP', path: '/program/bp', mode: 'full_screen_graphic' },
  { id: 'gameplay', title: '比赛中', path: '/program', mode: 'gameplay_overlay' },
  { id: 'halftime', title: '半场', path: '/program/halftime', mode: 'full_screen_graphic' },
  { id: 'map_result', title: '单图结果', path: '/program/map-result', mode: 'full_screen_graphic' },
  { id: 'intermap', title: '图间', path: '/program/intermap', mode: 'full_screen_graphic' },
  {
    id: 'match_result',
    title: '整场结果',
    path: '/program/match-result',
    mode: 'full_screen_graphic',
  },
] as const;

export const programSceneIdSchema = z.enum(
  PROGRAM_SCENES.map((scene) => scene.id) as [
    (typeof PROGRAM_SCENES)[number]['id'],
    ...(typeof PROGRAM_SCENES)[number]['id'][],
  ],
);
export type ProgramSceneId = z.infer<typeof programSceneIdSchema>;
export type ProgramScene = (typeof PROGRAM_SCENES)[number];

export function programScene(id: ProgramSceneId): ProgramScene {
  return PROGRAM_SCENES.find((scene) => scene.id === id)!;
}

export function programSceneForPath(path: string): ProgramScene | undefined {
  return PROGRAM_SCENES.find((scene) => scene.path === path);
}

export const programSceneStateSchema = z.object({
  schemaVersion: z.literal('mizar.program-scenes.v1'),
  active: programSceneIdSchema,
  revision: z.string().min(1),
  available: z.array(programSceneIdSchema),
  director: z
    .object({
      mode: z.enum(['auto', 'manual', 'blocked', 'preparation']),
      next: programSceneIdSchema.nullable(),
      reason: z.string().nullable(),
      introDurationMs: z.number().nonnegative(),
      sceneElapsedMs: z.number().nonnegative(),
    })
    .optional(),
  blocked: z.partialRecord(programSceneIdSchema, z.string()),
});
export type ProgramSceneState = z.infer<typeof programSceneStateSchema>;

/** Presentation is deliberately narrower than the live Program channel. */
const summaryPlayerSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  kills: z.number().nullable(),
  assists: z.number().nullable(),
  deaths: z.number().nullable(),
});
export const mapSummarySchema = z.object({
  matchId: z.string(),
  mapOrder: z.number().int().positive(),
  mapName: z.string(),
  cursor: projectionCursorSchema,
  score: z.object({ a: z.number().nullable(), b: z.number().nullable() }),
  players: z.object({
    a: z.array(summaryPlayerSchema).max(5),
    b: z.array(summaryPlayerSchema).max(5),
  }),
});
export type MapSummary = z.infer<typeof mapSummarySchema>;
const scheduleCardSchema = z.object({
  matchId: z.string(),
  a: z.string(),
  b: z.string(),
  scheduledAt: z.string().nullable(),
  stage: z.string(),
  format: z.string(),
  score: z.string().nullable(),
});
export const programPresentationSchema = z
  .object({
    schemaVersion: z.literal('mizar.program-presentation.v1'),
    packageId: z.literal('builtin:mizar-default'),
    match: programPayloadSchema.shape.match,
    series: programPayloadSchema.shape.series,
    halftime: mapSummarySchema.nullable(),
    completed: z.array(mapSummarySchema).max(5),
    eventLogoUrl: z.string().nullable(),
    scheduledAt: z.string().nullable(),
    previous: scheduleCardSchema.nullable(),
    next: scheduleCardSchema.nullable(),
  })
  .strict();
export type ProgramPresentation = z.infer<typeof programPresentationSchema>;
