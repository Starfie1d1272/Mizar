import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as yieldIO } from 'node:timers/promises';
import { SessionJournal } from '../../src/support/session-journal.js';
import { PerformanceWindow, selectedGsiContext } from '../../src/support/performance-window.js';
const directory = await mkdtemp(join(tmpdir(), 'mizar-context-cost-'));
const journal = new SessionJournal(directory);
let now = 0;
const context = new PerformanceWindow(journal, () => now);
const payload = {
  map: { name: 'de_ancient', phase: 'live', round: 10 },
  round: { phase: 'live' },
  phase_countdowns: { phase: 'live', phase_ends_in: '50.0' },
  allplayers: Object.fromEntries(
    Array.from({ length: 16 }, (_, i) => [
      'public-player-' + i,
      {
        position: '100,200,300',
        team: i < 8 ? 'CT' : 'T',
        observer_slot: i,
        state: { health: 100, armor: 100, flashed: 0, smoked: 0, burning: 0 },
      },
    ]),
  ),
};
const durations: number[] = [];
const started = performance.now();
try {
  for (let sequence = 0; sequence < 144000; sequence++) {
    now = sequence * 50;
    const start = performance.now();
    if (context.shouldSample(now))
      context.sample({
        time: new Date(now).toISOString(),
        monotonicMs: now,
        sequence,
        evidence: {
          input: selectedGsiContext(payload),
          normalizedBeforeCurrentRaw: { sequence: sequence - 1 },
          publicationBeforeCurrentRaw: [
            { channel: 'program', channelSeq: sequence - 1 },
            { channel: 'radar', channelSeq: sequence - 1 },
          ],
        },
      });
    if (sequence % 1200 === 600) context.trigger('public-benchmark-error', { sequence });
    durations.push(performance.now() - start);
    if (sequence % 20 === 0) await yieldIO();
  }
  await context.close();
  await journal.close();
  durations.sort((a, b) => a - b);
  console.log(
    JSON.stringify({
      scope:
        'accelerated 2h/20Hz synthetic 16-player bounded context handoff plus 120 anomaly windows; excludes actual telemetry adaptation/runtime/render/OS game and is not a field latency result',
      frames: durations.length,
      wallMs: performance.now() - started,
      synchronousMs: {
        p50: durations[Math.floor(durations.length * 0.5)],
        p99: durations[Math.floor(durations.length * 0.99)],
        p999: durations[Math.floor(durations.length * 0.999)],
        max: durations.at(-1),
      },
      health: context.health(),
      journal: journal.health(),
    }),
  );
} finally {
  await context.close();
  await journal.close();
  await rm(directory, { recursive: true, force: true });
}
