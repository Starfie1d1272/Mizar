import type { AssistSnapshot } from '@mizar/protocol/assist';
import type { OperatorSnapshot } from '@mizar/protocol/operator';
import type { ProgramSnapshot } from '@mizar/protocol/program';
import type { RadarSnapshot } from '@mizar/protocol/radar';
import {
  createChannelSnapshotValidator,
  type SnapshotEnvelopeLike,
  type SnapshotValidator,
} from '@mizar/protocol/acceptance';
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
  readonly validator: SnapshotValidator<TSnapshot>;
}

export const localChannelConfigs = {
  program: {
    path: '/local/v1/program',
    validator: createChannelSnapshotValidator<ProgramSnapshot>('program'),
  },
  radar: {
    path: '/local/v1/radar',
    validator: createChannelSnapshotValidator<RadarSnapshot>('radar'),
  },
  operator: {
    path: '/local/v1/operator',
    validator: createChannelSnapshotValidator<OperatorSnapshot>('operator'),
  },
  assist: {
    path: '/local/v1/assist',
    validator: createChannelSnapshotValidator<AssistSnapshot>('assist'),
  },
} satisfies {
  readonly [C in LocalSnapshotChannel]: LocalChannelConfig<LocalChannelSnapshot<C>>;
};

export function getLocalChannelConfig<C extends LocalSnapshotChannel>(
  channel: C,
): LocalChannelConfig<LocalChannelSnapshot<C>> {
  return localChannelConfigs[channel] as unknown as LocalChannelConfig<LocalChannelSnapshot<C>>;
}
