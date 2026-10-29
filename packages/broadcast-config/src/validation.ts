import { z } from 'zod';
import {
  hudLayoutSchema,
  hudPresetSchema,
  hudThemeSchema,
  hudWidgetPlacementSchema,
  hudResolvedPresetSchema,
  parseHudLayout,
  parseHudPreset,
  parseHudResolvedPreset,
} from '@mizar/hud-config';
import { MUSIC_GROUPS, musicGroupSchema, musicTrackSchema } from '@mizar/protocol/music';
import { cameraMapSchema } from '@mizar/protocol/orchestration';
import { boundModules, type BroadcastConfigDocument } from './index.js';

const id = z.string().uuid();
const revision = z.string().min(1).max(200);
const sha = z.string().regex(/^[a-f0-9]{64}$/);
export const resourceRefSchema = z.strictObject({
  id: z.string().min(1).max(256),
  version: z.string().min(1).max(128),
  digest: sha,
});
export const assetRefSchema = z.strictObject({
  resource: resourceRefSchema,
  fileId: z.string().min(1).max(200),
});
const release = z.strictObject({
  repository: z.literal('Co1Swet/MulNX_CS2'),
  releaseId: z.number().int().positive(),
  assetId: z.number().int().positive(),
  tag: z.string().min(1).max(200),
  archiveSha256: sha,
});
const { id: _trackId, entryId: _entryId, ...portableTrackFields } = musicTrackSchema.shape;
const track = z
  .strictObject({ ...portableTrackFields, entryId: id, asset: assetRefSchema })
  .refine((value) => value.endMs === null || value.endMs > value.startMs);
const group = musicGroupSchema.omit({ tracks: true }).extend({ tracks: z.array(track).max(64) });
const music = z
  .strictObject({
    version: z.literal(1),
    automaticEnabled: z.boolean(),
    groups: z.strictObject(
      Object.fromEntries(MUSIC_GROUPS.map((name) => [name, group])) as Record<
        (typeof MUSIC_GROUPS)[number],
        typeof group
      >,
    ),
  })
  .superRefine((value, ctx) => {
    for (const name of MUSIC_GROUPS) {
      const tracks = value.groups[name].tracks;
      if (name !== 'waiting' && name !== 'technical' && tracks.length > 1)
        ctx.addIssue({
          code: 'custom',
          path: ['groups', name, 'tracks'],
          message: '固定主题仅允许一首曲目',
        });
      if (new Set(tracks.map((item) => item.entryId)).size !== tracks.length)
        ctx.addIssue({ code: 'custom', path: ['groups', name, 'tracks'], message: '条目标识重复' });
    }
    const assets = MUSIC_GROUPS.flatMap((name) =>
      value.groups[name].tracks.map((item) => JSON.stringify(item.asset)),
    );
    if (new Set(assets).size > 128) ctx.addIssue({ code: 'custom', message: '曲目总数超过 128' });
  });
const cameraSource = z.strictObject({
  sourceName: z.string().trim().min(1).max(120),
  treeSha256: sha,
  converterVersion: z.literal(1),
  acquisition: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('upstream'), release }),
    z.strictObject({
      kind: z.literal('developer-fork'),
      repository: z.string().min(1).max(256),
      revision: z.string().min(1).max(200),
      archiveSha256: sha,
    }),
  ]),
});
const cameraMap = cameraMapSchema
  .omit({ pack: true, openingSound: true })
  .extend({ source: cameraSource, openingSound: track.nullable() });
const camera = z
  .strictObject({
    format: z.literal('mizar.camera-config'),
    version: z.literal(2),
    name: z.string().trim().min(1).max(120),
    automaticEnabled: z.boolean(),
    maps: z.array(cameraMap).max(32),
  })
  .refine((value) => new Set(value.maps.map((map) => map.map)).size === value.maps.length);
const visualColor = z.discriminatedUnion('source', [
  z.strictObject({ source: z.literal('fixed'), value: z.string().regex(/^#[0-9a-fA-F]{6}$/) }),
  z.strictObject({ source: z.literal('event'), fallback: z.string().regex(/^#[0-9a-fA-F]{6}$/) }),
]);
const nativeHud = z
  .strictObject({
    renderer: z.strictObject({
      kind: z.literal('native'),
      id: z.literal('mizar.hud'),
      apiVersion: z.literal(1),
    }),
    preset: hudPresetSchema,
    layout: hudLayoutSchema,
    theme: hudThemeSchema,
    overlays: z.strictObject({
      pause: z.strictObject({ enabled: z.boolean(), visual: z.string().min(1) }),
      chat: z.strictObject({ enabled: z.boolean(), placement: hudWidgetPlacementSchema }),
    }),
    accent: visualColor,
  })
  .superRefine((value, ctx) => {
    try {
      parseHudPreset(value.preset);
      parseHudLayout(value.layout);
    } catch {
      ctx.addIssue({ code: 'custom', message: 'HUD 配置无效' });
    }
    if (value.preset.layoutId !== value.layout.id || value.preset.themeId !== value.theme.id)
      ctx.addIssue({ code: 'custom', message: 'HUD 引用不一致' });
  });
const webHud = z.strictObject({
  renderer: z.strictObject({
    kind: z.literal('web-hud'),
    resource: resourceRefSchema,
    profile: z.literal('lhm-cs2-v1'),
    variant: z.string().max(200).nullable(),
  }),
  panelValues: z.record(
    z.string(),
    z.union([
      z.string(),
      z.number().finite(),
      z.boolean(),
      z.null(),
      z.strictObject({ entity: z.enum(['player', 'match']), binding: z.string().min(1) }),
    ]),
  ),
  panelAssets: z.record(z.string(), assetRefSchema),
});
const hud = z.union([nativeHud, webHud]);
const scene = z.union([
  z.strictObject({ kind: z.literal('builtin'), id: z.string().min(1), apiVersion: z.literal(1) }),
  z.strictObject({
    kind: z.literal('declarative'),
    resource: resourceRefSchema,
    fileId: z.string().min(1),
    apiVersion: z.literal(1),
  }),
]);
const program = z.strictObject({
  scenes: z.strictObject({
    waiting: scene,
    matchup: scene,
    bp: scene,
    halftime: scene,
    map_result: scene,
    intermap: scene,
    match_result: scene,
  }),
  tokens: z.record(z.string(), z.union([z.string(), z.number().finite()])),
  assets: z.record(z.string(), assetRefSchema),
});
const origin = z
  .strictObject({ resource: resourceRefSchema, entryId: z.string().min(1) })
  .nullable();
const common = { id, revision, name: z.string().trim().min(1).max(120), origin };
const module = z.discriminatedUnion('kind', [
  z.strictObject({ ...common, kind: z.literal('hud'), schemaVersion: z.literal(1), value: hud }),
  z.strictObject({
    ...common,
    kind: z.literal('program'),
    schemaVersion: z.literal(1),
    value: program,
  }),
  z.strictObject({
    ...common,
    kind: z.literal('music'),
    schemaVersion: z.literal(1),
    value: music,
  }),
  z.strictObject({
    ...common,
    kind: z.literal('camera'),
    schemaVersion: z.literal(2),
    value: camera,
  }),
]);
const binding = z.discriminatedUnion('mode', [
  z.strictObject({
    kind: z.enum(['hud', 'program', 'music', 'camera']),
    mode: z.literal('use'),
    moduleId: id,
  }),
  z.strictObject({ kind: z.enum(['hud', 'program', 'music', 'camera']), mode: z.literal('off') }),
]);
const preset = z.strictObject({
  schemaVersion: z.literal(1),
  ...common,
  bindings: z.array(binding).length(4),
  opaqueModules: z.array(
    z.strictObject({
      module: z.string().min(1),
      schemaVersion: z.number().int().positive(),
      source: resourceRefSchema,
      entryId: z.string().min(1),
      presetEntryId: z.string().min(1),
      required: z.literal(false),
    }),
  ),
});
const resolvedHud = z.union([
  z.strictObject({
    renderer: z.literal('native'),
    config: hudResolvedPresetSchema.superRefine((value, ctx) => {
      try {
        parseHudResolvedPreset(value);
      } catch {
        ctx.addIssue({ code: 'custom', message: 'HUD 快照无效' });
      }
    }),
  }),
  z.strictObject({ renderer: z.literal('web-hud'), config: webHud }),
]);
const snapshot = z.strictObject({
  schemaVersion: z.literal(1),
  revision,
  sourcePreset: z.strictObject({ id, revision }).nullable(),
  adjusted: z.boolean(),
  moduleRevisions: z.strictObject({
    hud: revision,
    program: revision,
    music: revision,
    camera: revision,
  }),
  resolved: z.strictObject({
    hud: resolvedHud,
    program,
    music: music.nullable(),
    camera: camera.nullable(),
  }),
  lock: z.strictObject({ resources: z.array(resourceRefSchema), tools: z.array(release) }),
});
const documentSchema = z.strictObject({
  schemaVersion: z.literal(1),
  modules: z.array(module),
  presets: z.array(preset),
  active: snapshot,
  previousActive: snapshot.nullable(),
});

export function parseBroadcastConfigDocument(input: unknown): BroadcastConfigDocument {
  const parsed = documentSchema.parse(input) as BroadcastConfigDocument;
  if (
    new Set(parsed.modules.map((item) => item.id)).size !== parsed.modules.length ||
    new Set(parsed.presets.map((item) => item.id)).size !== parsed.presets.length
  )
    throw new Error('duplicate_id');
  for (const item of parsed.presets) boundModules(item, parsed.modules);
  return parsed;
}
