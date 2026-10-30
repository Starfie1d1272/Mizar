import process from 'node:process';
import { setInterval } from 'node:timers';
import { URL } from 'node:url';
// Synthetic local child: no SDK, network or game process.
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
const arg = (name) => args[args.indexOf(name) + 1];
import { createInterface } from 'node:readline';
const inputLines = createInterface({ input: process.stdin });
let cleanupFailure = false;
for await (const text of inputLines) {
  const input = JSON.parse(text);
  cleanupFailure = input.endpoint === '127.0.0.5:27020';
  if (
    process.argv.some(
      (value) =>
        (input.password.length > 0 && value.includes(input.password)) ||
        value.includes(input.endpoint),
    )
  )
    process.exit(90);
  // A stalled pre-report initialization may never create the first leaf.
  if (
    input.endpoint === '127.0.0.20:27020' &&
    !path.basename(arg('--output')).startsWith('retry-')
  ) {
    fs.writeFileSync(
      path.join(path.dirname(arg('--output')), 'pre-mkdir.json'),
      JSON.stringify({ pid: process.pid }),
    );
    setInterval(() => {}, 1000);
    await new Promise(() => {});
  }
  // Match pinned driver: create only the unique leaf, never its ancestors.
  try {
    fs.mkdirSync(arg('--output'), { mode: 0o700 });
  } catch {
    process.stderr.write('output-directory-unavailable\n');
    process.exit(1);
  }
  const validReport = (reason) =>
    JSON.stringify({
      schema: 'cs2-observer-report/1',
      reachedFull: false,
      drainCompleted: false,
      cleanupCompleted: true,
      outcome: 'failed',
      reason,
    });
  const earlyFailures = {
    '127.0.0.11:27020': 'output-directory-unavailable\nSynthetic interpreter shutdown diagnostic',
    '127.0.0.12:27020': 'configuration-boundary',
    '127.0.0.13:27020':
      'Traceback private path and ' + input.password + '\nValueError: node-runtime-probe-failed',
    '127.0.0.14:27020': '',
    '127.0.0.15:27020': '{"schema":',
    '127.0.0.16:27020': 'private unknown stderr ' + input.password,
    '127.0.0.17:27020': JSON.stringify({
      schema: 'cs2-observer-report/1',
      reachedFull: false,
      drainCompleted: false,
      cleanupCompleted: true,
      outcome: 'failed',
      reason: input.password,
    }),
    '127.0.0.18:27020': JSON.stringify({
      schema: 'cs2-observer-report/1',
      reachedFull: false,
      drainCompleted: false,
      cleanupCompleted: true,
      outcome: 'failed',
      reason: 'ordered-parser-exited',
    }),
    '127.0.0.19:27020':
      'output-directory-unavailable\n' +
      JSON.stringify({
        schema: 'cs2-observer-report/1',
        reachedFull: false,
        drainCompleted: false,
        cleanupCompleted: true,
        outcome: 'failed',
        reason: 'native-start-failed',
        native_boot_code: 2,
      }),
    '127.0.0.21:27020': validReport('native-start-failed') + '\nSynthetic shutdown diagnostic',
    '127.0.0.22:27020': validReport('native-start-failed') + '\n{"malformed":',
    '127.0.0.23:27020':
      validReport('native-start-failed') + '\n' + validReport('ordered-parser-exited'),
    '127.0.0.24:27020':
      validReport('native-start-failed') +
      '\n' +
      JSON.stringify({
        online_success: 'INCONCLUSIVE',
        outcome: 'failed',
        reason: input.password,
      }) +
      '\nprivate trailing path ' +
      input.password,
  };
  if (Object.hasOwn(earlyFailures, input.endpoint)) {
    process.stderr.write(earlyFailures[input.endpoint]);
    process.exitCode = 1;
    inputLines.close();
    process.stdin.destroy();
    break;
  }
  if (input.endpoint === '127.0.0.2:27020') {
    process.stderr.write(
      JSON.stringify({
        schema: 'cs2-observer-report/1',
        reachedFull: false,
        drainCompleted: false,
        cleanupCompleted: true,
        outcome: 'failed',
        reason: 'native-start-failed',
        native_boot_code: 2,
        steam_init_result: 1,
        finalization_failures: ['close-session', input.password],
        privateInput: input,
      }),
    );
    process.exitCode = 7;
    inputLines.close();
    process.stdin.destroy();
    break;
  }
  if (input.endpoint === '127.0.0.4:27020') {
    process.stderr.write('x'.repeat(65537));
    process.exitCode = 2;
    inputLines.close();
    process.stdin.destroy();
    break;
  }
  if (input.endpoint === '127.0.0.3:27020') {
    process.stdout.write('{bad}\n');
    setInterval(() => {}, 1000);
    await new Promise(() => {});
  }
  const source = arg('--source-role') + ':' + arg('--source-id');
  const supervised = /^127\.0\.0\.(6|7|8|9|10|20):27020$/.test(input.endpoint);
  const retrying = path.basename(arg('--output')).startsWith('retry-');
  if (supervised) {
    const directory = arg('--output');
    fs.writeFileSync(
      path.join(directory, 'child.json'),
      JSON.stringify({ source, pid: process.pid }),
    );
  }
  const terminal = (outcome, reason, remote = 0) => {
    process.stderr.write('Synthetic SDK diagnostic before the final report\n');
    process.stderr.write(
      JSON.stringify({
        schema: 'cs2-observer-report/1',
        reachedFull: true,
        drainCompleted: outcome === 'closed',
        cleanupCompleted: true,
        outcome,
        reason,
        remote_end_reason: remote,
        finalization_failures: [],
      }) + '\n',
    );
    process.exitCode = outcome === 'closed' ? 0 : 1;
    inputLines.close();
    process.stdin.destroy();
  };
  if ((input.endpoint === '127.0.0.7:27020' && !retrying) || input.endpoint === '127.0.0.8:27020') {
    terminal('failed', 'initialization-timeout');
    break;
  }
  if (input.endpoint === '127.0.0.9:27020') {
    terminal('failed', 'native-session-closed', 2033);
    break;
  }
  const event = JSON.parse(
    fs.readFileSync(new URL('./observer-event.json', import.meta.url), 'utf8'),
  );
  const cursor = {
    kind: 'cursor',
    source,
    channel: 1,
    world: 1,
    sequence: 6,
    tick: 99,
    tickInterval: 1 / 64,
    map: 'de_test',
  };
  process.stdout.write(JSON.stringify(cursor) + '\n');
  process.stdout.write(JSON.stringify({ ...event, source, world: 1 }) + '\n');
  if (input.endpoint === '127.0.0.25:27020') {
    process.stdout.write(
      JSON.stringify({
        ...cursor,
        kind: 'round_freeze_end',
        type: 'raw-event',
        name: 'round_freeze_end',
        sequence: 9,
        tick: 100,
        committedTick: 100,
        round: 6,
      }) + '\n',
    );
    process.stdout.write(
      JSON.stringify({
        ...cursor,
        sequence: 10,
        tick: 164,
        round: 6,
        warmup: false,
        roundClock: {
          status: 'available',
          totalRoundsPlayed: 6,
          committedTick: 164,
          freezePeriod: false,
          warmupPeriod: false,
          bombPlanted: false,
          startTime: 100 / 64,
          duration: 115,
          pause: { active: false, totalPausedTicks: 0 },
        },
      }) + '\n',
    );
  }
  if (input.endpoint === '127.0.0.6:27020' && !retrying) {
    terminal('failed', 'native-session-closed', 1000);
    break;
  }
  if (input.endpoint === '127.0.0.10:27020') {
    terminal('closed', 'source-hltv-stop', 1038);
    break;
  }
}
if (cleanupFailure) {
  process.stderr.write(
    JSON.stringify({
      schema: 'cs2-observer-report/1',
      reachedFull: false,
      drainCompleted: false,
      cleanupCompleted: true,
      outcome: 'failed',
      reason: 'owner-stopped',
      finalization_failures: ['close-session'],
    }),
  );
}
process.exitCode ??= 2;
