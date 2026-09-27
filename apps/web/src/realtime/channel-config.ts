import { assistSnapshotSchema, type AssistSnapshot } from '@mizar/protocol/assist';
import { operatorSnapshotSchema, type OperatorSnapshot } from '@mizar/protocol/operator';
import { programSnapshotSchema, type ProgramSnapshot } from '@mizar/protocol/program';
import { radarSnapshotSchema, type RadarSnapshot } from '@mizar/protocol/radar';
import type { SnapshotEnvelopeLike, SnapshotSchema } from '@mizar/protocol/acceptance';
import { LOCAL_PROTOCOL_SUBPROTOCOL, type LocalSnapshotChannel } from '@mizar/protocol/version';

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
  readonly schema: SnapshotSchema<TSnapshot>;
}

export const localChannelConfigs = {
  program: {
    path: '/local/v1/program',
    schema: programSnapshotSchema,
  },
  radar: {
    path: '/local/v1/radar',
    schema: radarSnapshotSchema,
  },
  operator: {
    path: '/local/v1/operator',
    schema: operatorSnapshotSchema,
  },
  assist: {
    path: '/local/v1/assist',
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
