import { expect, it } from 'vitest';
import { MulnxProgramClock } from '../src/orchestration/mulnx-clock.js';
import type { MulnxInput } from '../src/orchestration/provider.js';

it('tracks the subscribed clock and rejects stale generations and samples', () => {
  let receive: (input: MulnxInput) => void = () => {};
  const clock = new MulnxProgramClock({
    subscribeInput(listener) {
      receive = listener;
      return () => {
        receive = () => {};
      };
    },
  });
  const send = (
    generation: number,
    captureGeneration: number,
    tick: number,
    time: number,
    sampledAt = time,
  ) =>
    receive({
      kind: 'clock',
      generation,
      sample: {
        captureGeneration,
        tick,
        sampledAtUnixMs: sampledAt,
        receivedMonotonicMs: time,
        timeDomain: 'network_game_client_tick',
        readSucceeded: true,
      },
    });
  receive({ kind: 'subscribed', generation: 1 });
  send(1, 1, 10, 1000);
  send(1, 1, 74, 2000);
  expect(clock.current(2000)).toMatchObject({
    state: 'progressing',
    clock: { tick: 74, usable: true },
  });
  send(1, 2, 3, 3000);
  send(1, 2, 67, 4000);
  send(1, 1, 500, 4500);
  expect(clock.current(4500)).toMatchObject({ state: 'progressing', clock: { tick: 67 } });
  send(1, 2, 68, 5000, 3000);
  expect(clock.current(5000)).toEqual({ state: 'syncing', clock: null });
  receive({ kind: 'disconnected', generation: 2 });
  send(1, 2, 69, 6000);
  expect(clock.current(6000)).toEqual({ state: 'syncing', clock: null });
  clock.close();
});
