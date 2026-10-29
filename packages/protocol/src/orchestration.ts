import { z } from 'zod';
import { musicTrackSchema } from './music.js';

export const CAMERA_STAGES = [
  'warmup',
  'tactical',
  'technical',
  'halftime',
  'mapVictory',
  'matchVictory',
] as const;
const name = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .refine((s) => [...s].every((c) => c.charCodeAt(0) >= 32));
export const cameraShotSchema = z
  .object({
    macro: name,
    maxMs: z.number().int().min(500).max(60_000).default(6000),
  })
  .strict();
export const cameraMapSchema = z
  .object({
    map: z.string().regex(/^de_[a-z0-9_]{1,40}$/),
    pack: name,
    opening: cameraShotSchema.nullable().default(null),
    openingSound: musicTrackSchema.nullable().default(null),
    rounds: z.array(cameraShotSchema).max(64).default([]),
    pauseCandidates: z
      .object({
        tactical: z.array(cameraShotSchema).max(64).default([]),
        technical: z.array(cameraShotSchema).max(64).default([]),
      })
      .strict()
      .default({ tactical: [], technical: [] }),
    stages: z
      .object({
        warmup: cameraShotSchema.nullable().default(null),
        tactical: cameraShotSchema.nullable().default(null),
        technical: cameraShotSchema.nullable().default(null),
        halftime: cameraShotSchema.nullable().default(null),
        mapVictory: cameraShotSchema.nullable().default(null),
        matchVictory: cameraShotSchema.nullable().default(null),
      })
      .strict()
      .default({
        warmup: null,
        tactical: null,
        technical: null,
        halftime: null,
        mapVictory: null,
        matchVictory: null,
      }),
  })
  .strict();
export const orchestrationPresetSchema = z
  .object({
    format: z.literal('mizar.orchestration'),
    version: z.literal(1),
    name: name,
    maps: z.array(cameraMapSchema).max(32),
  })
  .strict()
  .refine((p) => new Set(p.maps.map((m) => m.map)).size === p.maps.length, '地图不能重复')
  .refine(
    (p) => new TextEncoder().encode(JSON.stringify(p, null, 2)).byteLength <= 256 * 1024,
    '预设超过 256 KiB',
  );
export type OrchestrationPreset = z.infer<typeof orchestrationPresetSchema>;
export type CameraShot = z.infer<typeof cameraShotSchema>;
export type CameraMap = z.infer<typeof cameraMapSchema>;
export function emptyOrchestrationPreset(): OrchestrationPreset {
  return { format: 'mizar.orchestration', version: 1, name: '我的编排', maps: [] };
}
export interface OrchestrationStatus {
  control: { mode: 'browser' | 'native'; state: 'ready' | 'blocked' };
  connected: boolean;
  connection: number;
  context: string;
  map: string | null;
  pack: string | null;
  isolated: boolean;
  held: boolean;
  preparation: 'waiting' | 'preparing' | 'ready' | 'error';
  request: 'idle' | 'submitted' | 'queued' | 'rejected' | 'unknown';
  execution: 'unconfirmed';
  current: string | null;
  message: string;
}
export interface MulnxToolView {
  installed: string | null;
  latest: string | null;
  busy: boolean;
  message: string;
  packs: { name: string; sourceName: string }[];
}
export interface OrchestrationView {
  tool?: MulnxToolView;
  preset: OrchestrationPreset;
  ready: boolean;
  status: OrchestrationStatus;
}
