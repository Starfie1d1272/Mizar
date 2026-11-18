import { afterEach, expect, it, vi } from 'vitest';
import { flushControlSnapshots, nativeSnapshot } from './control-journal';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('preserves CS2 facts across brief busy polls and flushes each observation once', () => {
  vi.useFakeTimers({ toFake: ['Date', 'performance'] });
  vi.stubGlobal('window', {});
  vi.stubGlobal('location', { pathname: '/workspace' });
  const records: Array<{ phase: string; evidence: { observations?: number; result: unknown } }> =
    [];
  vi.stubGlobal('fetch', (_url: string, init: RequestInit) => {
    records.push(JSON.parse(String(init.body)));
    return Promise.resolve(new Response(null, { status: 204 }));
  });
  const idle = { busy: false, phase: 'idle', running: false, pending: false };
  const busy = { busy: true, phase: 'checking', observerHudPending: false };
  nativeSnapshot('cs2_config_status', idle);
  for (let index = 0; index < 100; index++) {
    vi.advanceTimersByTime(1000);
    nativeSnapshot('cs2_config_status', busy);
    vi.advanceTimersByTime(1000);
    nativeSnapshot('cs2_config_status', idle);
  }
  expect(records.map((record) => record.phase)).toEqual(['snapshot']);
  flushControlSnapshots();
  flushControlSnapshots();
  expect(records.map((record) => [record.phase, record.evidence.observations])).toEqual([
    ['snapshot', 1],
    ['snapshot_aggregate', 100],
    ['busy_aggregate', 100],
  ]);
  for (let index = 0; index < 7; index++) {
    vi.advanceTimersByTime(1000);
    nativeSnapshot('cs2_config_status', busy);
  }
  const pending = { ...idle, pending: true, phase: 'pending' };
  nativeSnapshot('cs2_config_status', pending);
  expect(records.slice(3).map((record) => record.phase)).toEqual([
    'busy_sustained',
    'busy_aggregate',
    'busy_ended',
    'snapshot',
  ]);
  expect(records.at(-1)?.evidence.result).toEqual(pending);
});
