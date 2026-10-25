import { assistSnapshotSchema, type AssistSnapshotInput } from '../src/assist.js';
import { ASSIST_SCHEMA_VERSION, LOCAL_PROTOCOL_VERSION } from '../src/version.js';
import { expect, it } from 'vitest';
import {
  DEFAULT_OBSERVER_SETTINGS,
  observerSettingsSchema,
  parseObserverConnection,
} from '../src/assist.js';
it('starts with the private feature off and editable 120/7 timing', () => {
  expect(DEFAULT_OBSERVER_SETTINGS).toMatchObject({
    enabled: false,
    expectedDelaySeconds: 120,
    leadSeconds: 7,
  });
  expect(
    observerSettingsSchema.safeParse({
      ...DEFAULT_OBSERVER_SETTINGS,
      leadSeconds: 30,
      expectedDelaySeconds: 10,
    }).success,
  ).toBe(false);
});
it('parses one authorized connection with adjacent or explicit Program endpoint', () => {
  expect(parseObserverConnection('connect 127.0.0.1:27025;password 1')).toEqual({
    earlyEndpoint: '127.0.0.1:27025',
    programEndpoint: '127.0.0.1:27026',
    password: '1',
  });
  expect(parseObserverConnection('connect 127.0.0.1:27026;password 1')).toEqual(
    parseObserverConnection('connect 127.0.0.1:27025;password 1'),
  );
  expect(
    parseObserverConnection('127.0.0.1:27025;password " a "', '127.0.0.2:28000').password,
  ).toBe(' a ');
  expect(
    parseObserverConnection('127.0.0.1:28000;password 1', '127.0.0.2:29000', '127.0.0.3:28000'),
  ).toMatchObject({ earlyEndpoint: '127.0.0.3:28000', programEndpoint: '127.0.0.2:29000' });
  for (const input of [
    '127.0.0.1:65535',
    '999.0.0.1:27025',
    '127.0.0.1:27025;password 1;quit',
    'connect example.com:27025',
  ])
    expect(() => parseObserverConnection(input)).toThrow();
});

it('keeps the typed snapshot input consistent with assist schema 2', () => {
  const input: AssistSnapshotInput = {
    type: 'snapshot',
    protocolVersion: LOCAL_PROTOCOL_VERSION,
    channel: 'assist',
    schemaVersion: ASSIST_SCHEMA_VERSION,
    cursor: {
      producerInstanceId: 'test',
      liveSessionId: null,
      runtimeSeq: 1,
      programSourceGeneration: 1,
      programReceiveSequence: 1,
      mapEpoch: 1,
    },
    payload: { availability: 'unavailable' },
  };
  expect(assistSnapshotSchema.parse({ ...input, channelSeq: 1 }).schemaVersion).toBe(2);
});
