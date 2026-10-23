import { afterEach, expect, it, vi } from 'vitest';
import { ProgramChat } from '../src/projections/program-chat.js';
const cursor = {
  producerInstanceId: 'host',
  liveSessionId: 'match',
  runtimeSeq: 1,
  programSourceGeneration: 1,
  programReceiveSequence: 1,
  mapEpoch: 1,
};
afterEach(() => vi.useRealTimers());
it('publishes bounded fresh public text and clears it on map, reconnect, session and staleness boundaries', () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-24T00:00:00Z'));
  const chat = new ProgramChat();
  chat.view(cursor, true);
  vi.advanceTimersByTime(1000);
  const record = (id: string) => ({
    stage: 'program_all_chat',
    detail: JSON.stringify({
      binding: 'owned-game',
      id,
      sender: 'm0NESY',
      text: 'HFHF',
      sourceAfterUtc: new Date().toISOString(),
      capturedAt: new Date().toISOString(),
    }),
  });
  for (let i = 0; i < 5; i++) chat.ingest(record(String(i)));
  chat.ingest(record('4'));
  expect(chat.view(cursor, true).map((item) => item.id)).toEqual(['2', '3', '4']);
  expect(chat.view({ ...cursor, mapEpoch: 2 }, true)).toEqual([]);
  chat.ingest(record('late-old-map'));
  vi.advanceTimersByTime(1);
  chat.ingest(record('new-map'));
  expect(chat.view({ ...cursor, mapEpoch: 2 }, true)).toHaveLength(1);
  expect(chat.view({ ...cursor, programSourceGeneration: 2 }, true)).toEqual([]);
  expect(chat.view({ ...cursor, liveSessionId: 'new-match' }, true)).toEqual([]);
  vi.advanceTimersByTime(1);
  chat.ingest(record('new'));
  expect(chat.view({ ...cursor, liveSessionId: 'new-match' }, true)).toHaveLength(1);
  vi.advanceTimersByTime(15001);
  expect(chat.view({ ...cursor, liveSessionId: 'new-match' }, true)).toEqual([]);
  expect(chat.view(cursor, false)).toEqual([]);
});
it('rejects stale, unknown-time, malformed and non-public producer events', () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-24T00:00:00Z'));
  const chat = new ProgramChat();
  chat.view(cursor, true);
  chat.ingest({ stage: 'private_chat', detail: '{}' });
  chat.ingest({ stage: 'program_all_chat', detail: 'invalid' });
  const detail = {
    binding: 'game',
    id: 'stale',
    sender: 'name',
    text: 'text',
    sourceAfterUtc: '2026-10-23T23:59:59Z',
    capturedAt: '2026-10-24T00:00:00Z',
  };
  chat.ingest({ stage: 'program_all_chat', detail: JSON.stringify(detail) });
  chat.ingest({
    stage: 'program_all_chat',
    detail: JSON.stringify({ ...detail, sourceAfterUtc: null }),
  });
  expect(chat.view(cursor, true)).toEqual([]);
});
