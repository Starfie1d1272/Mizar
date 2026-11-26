import { describe, expect, it } from 'vitest';
import {
  acceptSnapshot,
  createChannelSnapshotValidator,
  createSnapshotAcceptance,
} from '../src/acceptance.js';
import {
  ASSIST_SCHEMA_VERSION,
  LOCAL_PROTOCOL_VERSION,
  OPERATOR_SCHEMA_VERSION,
  PROGRAM_SCHEMA_VERSION,
  RADAR_SCHEMA_VERSION,
} from '../src/version.js';

const baseCursor = {
  producerInstanceId: 'prod-1',
  liveSessionId: 'sess-1',
  runtimeSeq: 1,
  programSourceGeneration: 1,
  programReceiveSequence: 1,
  mapEpoch: 1,
};

describe('zero-copy channel snapshot validators', () => {
  it('accepts valid program, radar, operator, and assist snapshots', () => {
    const program = {
      type: 'snapshot',
      protocolVersion: LOCAL_PROTOCOL_VERSION,
      channel: 'program',
      schemaVersion: PROGRAM_SCHEMA_VERSION,
      channelSeq: 1,
      cursor: baseCursor,
      payload: {
        status: { telemetry: 'fresh', context: 'fresh', identity: 'matched' },
        teams: { ct: {}, t: {} },
        map: { name: 'de_ancient' },
        players: [],
      },
    };
    const radar = {
      type: 'snapshot',
      protocolVersion: LOCAL_PROTOCOL_VERSION,
      channel: 'radar',
      schemaVersion: RADAR_SCHEMA_VERSION,
      channelSeq: 1,
      cursor: baseCursor,
      payload: { mapName: 'de_ancient', players: [], grenades: [] },
    };
    const operator = {
      type: 'snapshot',
      protocolVersion: LOCAL_PROTOCOL_VERSION,
      channel: 'operator',
      schemaVersion: OPERATOR_SCHEMA_VERSION,
      channelSeq: 1,
      cursor: baseCursor,
      payload: {
        runtime: {},
        matchContext: {},
        identity: {},
        activeLineup: {},
        sources: {},
      },
    };
    const assist = {
      type: 'snapshot',
      protocolVersion: LOCAL_PROTOCOL_VERSION,
      channel: 'assist',
      schemaVersion: ASSIST_SCHEMA_VERSION,
      channelSeq: 1,
      cursor: baseCursor,
      payload: { availability: 'ready', observer: { state: 'live' } },
    };

    expect(acceptSnapshot(program, createChannelSnapshotValidator('program')).kind).toBe(
      'accepted',
    );
    expect(acceptSnapshot(radar, createChannelSnapshotValidator('radar')).kind).toBe('accepted');
    expect(acceptSnapshot(operator, createChannelSnapshotValidator('operator')).kind).toBe(
      'accepted',
    );
    expect(acceptSnapshot(assist, createChannelSnapshotValidator('assist')).kind).toBe('accepted');
  });

  it('rejects malformed payloads such as { payload: {} } as schema-invalid', () => {
    for (const [channel, schemaVersion] of [
      ['program', PROGRAM_SCHEMA_VERSION],
      ['radar', RADAR_SCHEMA_VERSION],
      ['operator', OPERATOR_SCHEMA_VERSION],
      ['assist', ASSIST_SCHEMA_VERSION],
    ] as const) {
      const acceptance = createSnapshotAcceptance(createChannelSnapshotValidator(channel));
      const emptyPayload = {
        type: 'snapshot',
        protocolVersion: LOCAL_PROTOCOL_VERSION,
        channel,
        schemaVersion,
        channelSeq: 1,
        cursor: baseCursor,
        payload: {},
      };
      const result = acceptance.accept(emptyPayload);
      expect(result.kind).toBe('rejected');
      if (result.kind === 'rejected') {
        expect(result.reason).toBe('schema-invalid');
      }
    }
  });
});
