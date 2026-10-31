import { z } from 'zod';

/** Private loopback production configuration; never part of Match / Program output. */
export const MUSIC_GROUPS = [
  'waiting',
  'tactical',
  'technical',
  'halftime',
  'mapVictory',
  'matchVictory',
  'opening',
] as const;
export type MusicGroup = (typeof MUSIC_GROUPS)[number];
export const musicTrackSchema = z
  .object({
    id: z.string().regex(/^[a-f0-9]{64}\.(wav|mp3|ogg|flac|m4a)$/),
    entryId: z.string().uuid().optional(),
    name: z
      .string()
      .min(1)
      .max(120)
      .regex(/^[^\\/]+$/)
      .refine((s) => [...s].every((c) => c.charCodeAt(0) >= 32)),
    startMs: z.number().int().min(0).max(86_400_000).default(0),
    endMs: z.number().int().min(1).max(86_400_000).nullable().default(null),
    gain: z.number().finite().min(0).max(1).optional(),
  })
  .strict()
  .refine((t) => t.endMs === null || t.endMs > t.startMs);
export const musicGroupSchema = z
  .object({
    enabled: z.boolean().default(true),
    tracks: z.array(musicTrackSchema).max(64).default([]),
    order: z.enum(['sequence', 'shuffle']).default('sequence'),
    volume: z.number().min(0).max(1).default(0.5),
    fadeInMs: z.number().int().min(0).max(10_000).default(600),
    fadeOutMs: z.number().int().min(0).max(10_000).default(600),
  })
  .strict();
export const musicConfigSchema = z
  .object({
    version: z.literal(1),
    groups: z
      .object({
        waiting: musicGroupSchema,
        tactical: musicGroupSchema,
        technical: musicGroupSchema,
        halftime: musicGroupSchema,
        mapVictory: musicGroupSchema,
        matchVictory: musicGroupSchema,
        opening: musicGroupSchema,
      })
      .strict(),
  })
  .strict()
  .superRefine((config, ctx) => {
    for (const group of MUSIC_GROUPS)
      if (group !== 'waiting' && group !== 'technical' && config.groups[group].tracks.length > 1)
        ctx.addIssue({
          code: 'custom',
          path: ['groups', group, 'tracks'],
          message: '固定主题仅允许一首曲目',
        });
    for (const group of MUSIC_GROUPS) {
      const ids = config.groups[group].tracks.flatMap((track) =>
        track.entryId ? [track.entryId] : [],
      );
      if (new Set(ids).size !== ids.length)
        ctx.addIssue({
          code: 'custom',
          path: ['groups', group, 'tracks'],
          message: '条目标识重复',
        });
    }
    const total = new Set(MUSIC_GROUPS.flatMap((g) => config.groups[g].tracks.map((t) => t.id)))
      .size;
    if (total > 128) ctx.addIssue({ code: 'custom', message: '曲目总数超过 128' });
  });
export type MusicConfig = z.infer<typeof musicConfigSchema>;
export type MusicTrack = z.infer<typeof musicTrackSchema>;
export function defaultMusicConfig(): MusicConfig {
  return musicConfigSchema.parse({
    version: 1,
    groups: Object.fromEntries(MUSIC_GROUPS.map((g) => [g, {}])),
  });
}
export interface MusicStatus {
  held: boolean;
  stingerHeld?: boolean;
  connection: 'idle' | 'connected' | 'unavailable';
  message: string | null;
  bgm: { group: MusicGroup; track: string; volume: number; playbackId: string } | null;
  stinger: string | null;
  /** Last OBS media observation; unknown when the connection cannot be verified. */
  playback: 'playing' | 'paused' | 'stopped' | 'unknown';
  intent: 'automatic' | 'manual' | 'held';
  cursorMs: number | null;
  durationMs: number | null;
  segmentStartMs: number | null;
  segmentEndMs: number | null;
  monitor: 'enabled' | 'disabled' | 'mixed' | 'unknown';
  monitorPending?: boolean;
  preview?: MusicPreviewStatus;
}

/** Ephemeral loopback audition. Never a music configuration or formal cue. */
export const musicPreviewSchema = z
  .object({
    owner: z.string().uuid(),
    token: z.string().uuid(),
    operation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    expiresAt: z.number().finite(),
    action: z.enum(['start', 'update', 'lease', 'stop']),
    group: z.enum(MUSIC_GROUPS),
    track: musicTrackSchema,
    volume: z.number().min(0).max(1),
    fadeInMs: z.number().int().min(0).max(10_000),
    fadeOutMs: z.number().int().min(0).max(10_000),
    confirmed: z.boolean().default(false),
  })
  .strict();
export type MusicPreviewRequest = z.infer<typeof musicPreviewSchema>;
export interface MusicPreviewStatus {
  owner: string;
  token: string;
  group: MusicGroup;
  phase: 'requested' | 'confirmation' | 'playing' | 'stopped' | 'failed' | 'cleanup';
  message: string;
}
