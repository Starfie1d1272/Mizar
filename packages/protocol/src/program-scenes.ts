import { z } from 'zod';

/** One ordered registry shared by the operator, Program hosts and OBS reconciliation. */
export const PROGRAM_SCENES = [
  { id: 'waiting', title: '赛前等待', path: '/program/waiting', mode: 'full_screen_graphic' },
  { id: 'matchup', title: '对阵', path: '/program/matchup', mode: 'full_screen_graphic' },
  { id: 'bp', title: 'BP', path: '/program/bp', mode: 'full_screen_graphic' },
  { id: 'gameplay', title: '比赛中', path: '/program', mode: 'gameplay_overlay' },
  { id: 'halftime', title: '半场', path: '/program/halftime', mode: 'gameplay_overlay' },
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
  schemaVersion: z.literal('rivalhub.program-scenes.v1'),
  active: programSceneIdSchema,
  revision: z.string().min(1),
  available: z.array(programSceneIdSchema),
  blocked: z.partialRecord(programSceneIdSchema, z.string()),
});
export type ProgramSceneState = z.infer<typeof programSceneStateSchema>;
