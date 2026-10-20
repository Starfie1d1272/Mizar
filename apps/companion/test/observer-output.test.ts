import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createObserverSourceManager } from '../src/telemetry/cstv-source-manager.js';
import { consumeObserverOutput } from '../src/telemetry/observer-output.js';
const identity = { source: 'ahead:fixture', role: 'ahead' as const, channel: 1, world: 2 };
function manager() {
  const result = createObserverSourceManager({ role: 'lookahead', identity });
  result.start();
  return result;
}
const cursor = {
  kind: 'cursor',
  ...identity,
  sequence: 1,
  tick: 99,
  tickInterval: 1 / 64,
  map: 'de_test',
};
describe('owned observer output pipe', () => {
  it('decodes fragmented UTF8 records and retires readiness on EOF', async () => {
    const target = manager();
    const states: string[] = [];
    target.subscribe(() => states.push(target.getHealth().state));
    const data = Buffer.from(
      JSON.stringify(cursor) + '\n' + JSON.stringify({ note: '中文' }) + '\n',
    );
    const result = await consumeObserverOutput(
      Readable.from([...data].map((byte) => Buffer.from([byte]))),
      target,
    );
    expect(result).toEqual({ status: 'ended', parsedRecords: 2 });
    expect(states).toContain('live');
    expect(target.getHealth().state).toBe('reconnecting');
  });
  it.each([Buffer.from('{broken}\n'), Buffer.from([0xff, 10]), Buffer.alloc(65537, 32)])(
    'fails closed on malformed or oversized bytes',
    async (bytes) => {
      const target = manager();
      const result = await consumeObserverOutput(Readable.from([bytes]), target);
      expect(result.status).toBe('failed');
      expect(result.parsedRecords).toBe(0);
      expect(target.getHealth().state).toBe('reconnecting');
    },
  );
  it('bounds an oversized line split into otherwise valid chunks', async () => {
    const result = await consumeObserverOutput(
      Readable.from([Buffer.alloc(40000, 32), Buffer.alloc(40000, 32)]),
      manager(),
    );
    expect(result.status).toBe('failed');
  });
  it('cancels a waiting pipe without waiting for its next record', async () => {
    const stream = new Readable({ read() {} });
    const controller = new AbortController();
    const pending = consumeObserverOutput(stream, manager(), controller.signal);
    controller.abort();
    expect(await pending).toEqual({ status: 'cancelled', parsedRecords: 0 });
    expect(stream.destroyed).toBe(true);
  });
});
