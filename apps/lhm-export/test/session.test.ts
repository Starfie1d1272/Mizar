import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createLhmSession } from '../src/session.js';

type Snapshot = Parameters<Parameters<typeof createLhmSession>[0]['onSnapshot']>[0];
const frames = readFileSync(
  new URL('../../../fixtures/gsi/semantic/bomb/defuse/frames.jsonl', import.meta.url),
  'utf8',
)
  .trim()
  .split('\n')
  .map(
    (line) => JSON.parse(line) as { payload: { bomb?: { state?: string }; map: { name: string } } },
  );
const raw = frames.find((frame) => frame.payload.bomb?.state === 'defusing')!.payload;
const match = (id = 'match-a', mapName = raw.map.name) => ({
  id,
  current: true,
  matchType: 'bo3',
  left: { id: `${id}-a`, wins: 1 },
  right: { id: `${id}-b`, wins: 0 },
  vetos: [{ mapName, type: 'pick', teamId: `${id}-a`, mapEnd: false }],
});
const team = (path: string) => ({ _id: path.split('/').at(-1), name: path.split('/').at(-1) });
const avatar = { custom: '/player.png' };
const flush = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};
const sessions: ReturnType<typeof createLhmSession>[] = [];
function create(readJson: (path: string, signal: AbortSignal) => Promise<unknown>) {
  let snapshot: Snapshot = null;
  const session = createLhmSession({
    origin: 'http://localhost:3000',
    readJson,
    onSnapshot: (value) => {
      snapshot = value;
    },
  });
  sessions.push(session);
  return { session, current: () => snapshot };
}
beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] }));
afterEach(() => {
  for (const session of sessions.splice(0)) session.dispose();
  vi.useRealTimers();
});

it('keeps recovering match and avatar metadata at a capped rate, not once per GSI', async () => {
  let unavailable = true;
  const read = vi.fn(async (path: string) => {
    if (unavailable) {
      if (path.includes('/avatar/')) return {};
      throw new Error('temporary host failure');
    }
    return path === '/api/match/current'
      ? match()
      : path.startsWith('/api/teams/')
        ? team(path)
        : avatar;
  });
  const { session, current } = create(read);
  session.loadMatch();
  session.update(raw);
  await flush();
  unavailable = false;
  await vi.advanceTimersByTimeAsync(1000);
  expect(current()?.program.payload.match?.matchId).toBe('match-a');
  expect(current()?.program.payload.players.every((player) => player.avatarUrl !== null)).toBe(
    true,
  );
  expect(read.mock.calls.filter(([path]) => path === '/api/match/current')).toHaveLength(2);

  unavailable = true;
  session.loadMatch();
  await flush();
  for (let second = 0; second < 60; second++) {
    session.update(raw);
    await vi.advanceTimersByTimeAsync(1000);
  }
  expect(read.mock.calls.filter(([path]) => path === '/api/match/current')).toHaveLength(10);
  expect(read.mock.calls.filter(([path]) => path.includes('/avatar/'))).toHaveLength(100);
  unavailable = false;
  await vi.advanceTimersByTimeAsync(15_000);
  expect(current()?.program.payload.match?.matchId).toBe('match-a');
  expect(current()?.program.payload.players.every((player) => player.avatarUrl !== null)).toBe(
    true,
  );
  expect(read.mock.calls.filter(([path]) => path === '/api/match/current')).toHaveLength(11);
});

it('refreshes same-match metadata without renewing input, but a different match needs new compatible input', async () => {
  let value = match();
  let release: ((value: unknown) => void) | undefined;
  let pending: Promise<unknown> | undefined = new Promise((resolve) => {
    release = resolve;
  });
  const { session, current } = create(async (path) =>
    path === '/api/match/current'
      ? (pending ?? value)
      : path.startsWith('/api/teams/')
        ? team(path)
        : avatar,
  );
  session.loadMatch();
  session.update(raw);
  const initial = current()!.program;
  expect(initial.payload.match).toBeNull();
  await vi.advanceTimersByTimeAsync(1100);
  release!(value);
  pending = undefined;
  await flush();
  expect(current()?.program.payload.match?.matchId).toBe('match-a');
  expect(current()?.program.payload.bomb?.action?.remainingSeconds).toBeNull();
  expect(current()?.program.cursor).toEqual(initial.cursor);
  expect(current()?.program.channelSeq).toBe(initial.channelSeq);
  session.loadMatch();
  await flush();
  expect(current()?.program.cursor).toEqual(initial.cursor);

  pending = new Promise((resolve) => {
    release = resolve;
  });
  session.loadMatch();
  await vi.advanceTimersByTimeAsync(19_000);
  expect(current()).toBeNull();
  release!(value);
  pending = undefined;
  await flush();
  expect(current()).toBeNull();
  session.update(null);
  expect(current()).toBeNull();
  session.update(raw);
  expect(current()?.program.payload.match?.matchId).toBe('match-a');

  value = match('match-b', 'de_nuke');
  session.loadMatch();
  await flush();
  expect(current()).toBeNull();
  session.update(raw);
  expect(current()?.program.payload.map.name).toBe(raw.map.name);
  expect(current()?.program.payload.match).toBeNull();
  expect(current()?.program.payload.teams.ct.mode).toBe('neutral');
  session.update({ ...raw, map: { ...raw.map, name: 'de_nuke' } });
  expect(current()?.program.payload.match?.matchId).toBe('match-b');
  expect(current()?.program.payload.teams.ct.name).toBe('match-b-a');
});

it('retires requests and retry timers on reconnect, match change and disposal', async () => {
  let release: ((value: unknown) => void) | undefined;
  let pending: Promise<unknown> | undefined = new Promise((resolve) => {
    release = resolve;
  });
  const signals: AbortSignal[] = [];
  const read = vi.fn(async (path: string, signal: AbortSignal) => {
    signals.push(signal);
    if (path === '/api/match/current') return pending ?? match('match-b');
    if (path.startsWith('/api/teams/')) return team(path);
    throw new Error('avatar unavailable');
  });
  const { session, current } = create(read);
  session.loadMatch();
  session.update(raw);
  await flush();
  const oldSignals = [...signals];
  session.disconnect();
  expect(current()).toBeNull();
  expect(oldSignals.every((signal) => signal.aborted)).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
  pending = undefined;
  session.loadMatch();
  session.update(raw);
  await flush();
  release!(match());
  await flush();
  expect(current()?.program.payload.match?.matchId).toBe('match-b');
  session.loadMatch();
  await flush();
  session.dispose();
  const count = read.mock.calls.length;
  await vi.advanceTimersByTimeAsync(30_000);
  session.update(raw);
  session.loadMatch();
  expect(read).toHaveBeenCalledTimes(count);
  expect(vi.getTimerCount()).toBe(0);
});
