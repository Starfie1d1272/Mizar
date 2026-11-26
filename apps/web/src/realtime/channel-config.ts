import { assistSnapshotSchema, type AssistSnapshot } from '@mizar/protocol/assist';
import { operatorSnapshotSchema, type OperatorSnapshot } from '@mizar/protocol/operator';
import { programSnapshotSchema, type ProgramSnapshot } from '@mizar/protocol/program';
import { radarSnapshotSchema, type RadarSnapshot } from '@mizar/protocol/radar';
import type { SnapshotEnvelopeLike, SnapshotSchema } from '@mizar/protocol/acceptance';
import {
  ASSIST_SCHEMA_VERSION,
  LOCAL_PROTOCOL_SUBPROTOCOL,
  OPERATOR_SCHEMA_VERSION,
  PROGRAM_SCHEMA_VERSION,
  RADAR_SCHEMA_VERSION,
  type LocalSnapshotChannel,
} from '@mizar/protocol/version';

export { LOCAL_PROTOCOL_SUBPROTOCOL };

export type LocalChannelSnapshot<C extends LocalSnapshotChannel> = C extends 'program'
  ? ProgramSnapshot
  : C extends 'radar'
    ? RadarSnapshot
    : C extends 'operator'
      ? OperatorSnapshot
      : AssistSnapshot;

export interface LocalChannelConfig<TSnapshot extends SnapshotEnvelopeLike> {
  readonly path: string;
  readonly schemaVersion: number;
  readonly schema: SnapshotSchema<TSnapshot>;
}

export const localChannelConfigs = {
  program: {
    path: '/local/v1/program',
    schemaVersion: PROGRAM_SCHEMA_VERSION,
    schema: programSnapshotSchema,
  },
  radar: {
    path: '/local/v1/radar',
    schemaVersion: RADAR_SCHEMA_VERSION,
    schema: radarSnapshotSchema,
  },
  operator: {
    path: '/local/v1/operator',
    schemaVersion: OPERATOR_SCHEMA_VERSION,
    schema: operatorSnapshotSchema,
  },
  assist: {
    path: '/local/v1/assist',
    schemaVersion: ASSIST_SCHEMA_VERSION,
    schema: assistSnapshotSchema,
  },
} satisfies {
  readonly [C in LocalSnapshotChannel]: LocalChannelConfig<LocalChannelSnapshot<C>>;
};

export function getLocalChannelConfig<C extends LocalSnapshotChannel>(
  channel: C,
): LocalChannelConfig<LocalChannelSnapshot<C>> {
  return localChannelConfigs[channel] as unknown as LocalChannelConfig<LocalChannelSnapshot<C>>;
}
