import { assistSnapshotSchema, type AssistSnapshotInput } from '../src/assist.js';
import { ASSIST_SCHEMA_VERSION, LOCAL_PROTOCOL_VERSION } from '../src/version.js';
import { expect, it } from 'vitest';
import {
  DEFAULT_OBSERVER_SETTINGS,
  observerSettingsSchema,
  observerConnectionSchema,
  parseObserverConnection,
  formatObserverConnection,
} from '../src/assist.js';
it('starts with the private feature enabled and a five-second lead', () => {
  expect(DEFAULT_OBSERVER_SETTINGS).toMatchObject({
    enabled: true,

    leadSeconds: 5,
  });
  expect(
    observerSettingsSchema.safeParse({
      ...DEFAULT_OBSERVER_SETTINGS,
      leadSeconds: 31,
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

it('keeps the typed snapshot input consistent with assist schema 4', () => {
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
  expect(assistSnapshotSchema.parse({ ...input, channelSeq: 1 }).schemaVersion).toBe(4);
});

it('accepts restricted commands in either order and round-trips the formatter', () => {
  const expected = {
    earlyEndpoint: '127.0.0.1:27025',
    programEndpoint: '127.0.0.1:27026',
    password: ' a b ',
  };
  for (const input of [
    ' connect "127.0.0.1:27026" ; PASSWORD " a b " ; ',
    ' PASSWORD " a b " ; CoNnEcT 127.0.0.1:27025;',
  ])
    expect(parseObserverConnection(input)).toEqual(expected);
  expect(formatObserverConnection(expected)).toBe('connect 127.0.0.1:27026;password " a b "');
  expect(formatObserverConnection({ ...expected, password: 'synthetic' })).toBe(
    'connect 127.0.0.1:27026;password synthetic',
  );
  expect(parseObserverConnection(formatObserverConnection(expected))).toEqual(expected);
  const custom = {
    ...expected,
    earlyEndpoint: '127.0.0.2:28000',
    programEndpoint: '127.0.0.3:29000',
  };
  expect(
    parseObserverConnection(
      formatObserverConnection(custom),
      custom.programEndpoint,
      custom.earlyEndpoint,
    ),
  ).toEqual(custom);
  for (const input of [
    'password a; password b; connect 127.0.0.1:27025',
    'connect 127.0.0.1:27025; connect 127.0.0.1:27026',
    'connect 127.0.0.1:0',
    'connect 127.0.0.1:65536',
    'password "bad;quit";connect 127.0.0.1:27025',
    'password "bad\\value";connect 127.0.0.1:27025',
    'password 密码;connect 127.0.0.1:27025',
    'password a;quit;connect 127.0.0.1:27025',
    'connect 127.0.0.1:27025;;',
    'connect 127.0.0.1:27025\nquit',
  ])
    expect(() => parseObserverConnection(input)).toThrow();
});

it.each(['012.0.0.1', '127.000.0.1', '127.0.00.1', '127.0.0.01'])(
  'rejects noncanonical IPv4 %s consistently at input, advanced endpoints and formatter',
  (ip) => {
    const invalid = `${ip}:27025`;
    const valid = {
      earlyEndpoint: '127.0.0.1:27025',
      programEndpoint: '127.0.0.1:27026',
      password: 'synthetic',
    };
    for (const input of [
      `connect ${invalid};password synthetic`,
      `password synthetic;connect ${invalid}`,
    ])
      expect(() => parseObserverConnection(input)).toThrow();
    expect(() => parseObserverConnection('127.0.0.1:28000', invalid, '127.0.0.2:28000')).toThrow();
    expect(() => parseObserverConnection('127.0.0.1:28000', '127.0.0.2:29000', invalid)).toThrow();
    for (const key of ['earlyEndpoint', 'programEndpoint'] as const) {
      const connection = { ...valid, [key]: invalid };
      expect(observerConnectionSchema.safeParse(connection).success).toBe(false);
      expect(() => formatObserverConnection(connection)).toThrow();
    }
  },
);
it('preserves canonical IPv4 with single zero octets without rewriting addresses', () => {
  const connection = {
    earlyEndpoint: '0.0.0.0:27025',
    programEndpoint: '127.0.0.1:27026',
    password: '',
  };
  expect(observerConnectionSchema.parse(connection)).toEqual(connection);
  expect(parseObserverConnection('connect 0.0.0.0:27025')).toMatchObject({
    earlyEndpoint: '0.0.0.0:27025',
    programEndpoint: '0.0.0.0:27026',
  });
  expect(formatObserverConnection(connection)).toBe('connect 127.0.0.1:27026;password ""');
});
