export const BROADCAST_MANIFEST_SCHEMA_VERSION = 'rivalhub.broadcast-manifest.v1' as const;

export type BroadcastManifestSchemaVersion = typeof BROADCAST_MANIFEST_SCHEMA_VERSION;

import type {
  BroadcastCommentatorSchemaOutput,
  BroadcastCompetitionSchemaOutput,
  BroadcastEntrantSchemaOutput,
  BroadcastManifestSchemaOutput,
  BroadcastManifestV1SchemaOutput,
  BroadcastMapSchemaOutput,
  BroadcastMatchSchemaOutput,
  BroadcastPlayerSchemaOutput,
  BroadcastRosterSchemaOutput,
  BroadcastVetoStepSchemaOutput,
} from './schema.js';

type ReadonlyDeep<T> = T extends readonly (infer Item)[]
  ? readonly ReadonlyDeep<Item>[]
  : T extends object
    ? { readonly [Key in keyof T]: ReadonlyDeep<T[Key]> }
    : T;

export type BroadcastManifestV1 = ReadonlyDeep<BroadcastManifestV1SchemaOutput>;
export type BroadcastManifest = ReadonlyDeep<
  Omit<BroadcastManifestSchemaOutput, 'schemaVersion' | 'match'> & {
    schemaVersion: BroadcastManifestSchemaOutput['schemaVersion'];
    match: Omit<BroadcastMatchSchemaOutput, 'competition' | 'stage'> & {
      competition: BroadcastCompetitionSchemaOutput | null;
      stage: string | null;
    };
  }
>;
export type BroadcastCompetitionV1 = ReadonlyDeep<BroadcastCompetitionSchemaOutput>;
export type BroadcastMatchV1 = ReadonlyDeep<BroadcastMatchSchemaOutput>;
export type BroadcastPlayerV1 = ReadonlyDeep<BroadcastPlayerSchemaOutput>;
export type BroadcastRosterV1 = ReadonlyDeep<BroadcastRosterSchemaOutput>;
export type BroadcastEntrantV1 = ReadonlyDeep<BroadcastEntrantSchemaOutput>;
export type BroadcastVetoStepV1 = ReadonlyDeep<BroadcastVetoStepSchemaOutput>;
export type BroadcastMapV1 = ReadonlyDeep<BroadcastMapSchemaOutput>;
export type BroadcastCommentatorV1 = ReadonlyDeep<BroadcastCommentatorSchemaOutput>;
export type BroadcastMatchStatus = BroadcastMatchV1['status'];
export type BroadcastMatchFormat = BroadcastMatchV1['format'];
export type BroadcastSide = Exclude<BroadcastMapV1['teamAStartSide'], null>;
export type BroadcastVetoActionType = BroadcastVetoStepV1['actionType'];
