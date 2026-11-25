#!/usr/bin/env node
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
  // Match pinned observer: create only the unique leaf, never its ancestors.
  try {
    fs.mkdirSync(arg('--output'), { mode: 0o700 });
  } catch {
    process.stderr.write('output-directory-unavailable\n');
    process.exit(1);
  }
  const source = arg('--source-role') + ':' + arg('--source-id');
  const v2Health = (overrides = {}) => ({
    type: 'cs2-observer-health/2',
    source,
    channel: 1,
    world: 1,
    state: 'backoff',
    ready: false,
    reconnects: 0,
    ...overrides,
  });
  const v2Report = (reason, overrides = {}) =>
    JSON.stringify({
      schema: 'cs2-observer-report/2',
      outcome: 'failed',
      reason,
      lastOutputSequence: 0,
      cleanupCompleted: true,
      reportWritten: true,
      health: v2Health(),
      ...overrides,
    });
  const earlyFailures = {
    '127.0.0.25:27020': v2Report(
      'native-start-failed: ' +
        'context '.repeat(700) +
        'root-cause-at-end; password=' +
        input.password,
    ),
    '127.0.0.26:27020': 'interpreter-failure-prefix\n' + 'x'.repeat(64 * 1024) + input.password,
    '127.0.0.11:27020': 'output-directory-unavailable\nSynthetic shutdown diagnostic',
    '127.0.0.12:27020': 'configuration-boundary',
    '127.0.0.13:27020': 'configuration-boundary\nprivate diagnostic ' + input.password,
    '127.0.0.14:27020': '',
    '127.0.0.15:27020': '{"schema":',
    '127.0.0.16:27020': 'private unknown stderr ' + input.password,
    '127.0.0.17:27020': v2Report(input.password),
    '127.0.0.18:27020': v2Report('native-start-failed'),
    '127.0.0.19:27020': 'output-directory-unavailable\n' + v2Report('native-start-failed'),
    '127.0.0.21:27020': v2Report('native-start-failed') + '\nSynthetic shutdown diagnostic',
    '127.0.0.22:27020': v2Report('native-start-failed') + '\n{"malformed":',
    '127.0.0.23:27020': v2Report('native-start-failed') + '\n' + v2Report('initialization-timeout'),
    '127.0.0.24:27020':
      v2Report('native-start-failed') +
      '\n' +
      JSON.stringify({
        online_success: 'INCONCLUSIVE',
        outcome: 'failed',
        reason: input.password,
      }) +
      '\nprivate trailing path ' +
      input.password,
    // Rust 4.0 early failure can emit cs2-observer-report/2 with health: null.
    '127.0.0.29:27020': v2Report('native-start-failed', {
      health: null,
      nativeBootCode: 5,
      steamInitResult: 1,
      lastAttemptEnd: { phase: 'native-boot' },
    }),
  };
  if (Object.hasOwn(earlyFailures, input.endpoint)) {
    process.stderr.write(earlyFailures[input.endpoint] + '\n');
    process.exitCode = 1;
    inputLines.close();
    process.stdin.destroy();
    break;
  }
  if (input.endpoint === '127.0.0.27:27020') {
    process.stdout.write('invalid observer JSON\n');
    process.exitCode = 1;
    inputLines.close();
    process.stdin.destroy();
    break;
  }
  if (input.endpoint === '127.0.0.28:27020') {
    const health = v2Health({
      sdkQueueAgeUs: 420,
      sdkMaxAgeUs: 950,
      decodeUs: 180,
      decodeMaxUs: 310,
      lastDeliveredCursor: { sequence: 1 },
    });
    const report = {
      schema: 'cs2-observer-report/2',
      outcome: 'failed',
      reason: 'reconnect-budget-exhausted',
      lastOutputSequence: 1,
      cleanupCompleted: true,
      reportWritten: true,
      health,
    };
    await new Promise((resolve) =>
      process.stderr.write('noise\n' + 'x'.repeat(70 * 1024) + '\n', resolve),
    );
    process.stderr.write(JSON.stringify(health) + '\n');
    process.stderr.write(JSON.stringify(report) + '\n');
    process.exitCode = 1;
    inputLines.close();
    process.stdin.destroy();
    break;
  }
  if (input.endpoint === '127.0.0.2:27020') {
    process.stderr.write(
      v2Report('native-start-failed', { reportWritten: false, privateInput: input }),
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
  const supervised = /^127\.0\.0\.(6|7|8|9|10|20):27020$/.test(input.endpoint);
  const retrying = path.basename(arg('--output')).startsWith('retry-');
  if (supervised) {
    const directory = arg('--output');
    fs.writeFileSync(
      path.join(directory, 'child.json'),
      JSON.stringify({ source, pid: process.pid }),
    );
  }
  const terminal = (outcome, reason) => {
    process.stderr.write('Synthetic SDK diagnostic before the final report\n');
    process.stderr.write(
      v2Report(reason, {
        outcome,
        health: v2Health({ state: outcome === 'closed' ? 'stopped' : 'backoff', ready: true }),
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
    terminal('failed', 'native-session-closed');
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
    terminal('failed', 'native-session-closed');
    break;
  }
  if (input.endpoint === '127.0.0.10:27020') {
    terminal('closed', 'source-hltv-stop');
    break;
  }
}
if (cleanupFailure) {
  process.stderr.write(
    JSON.stringify({
      schema: 'cs2-observer-report/2',
      outcome: 'failed',
      reason: 'owner-stopped',
      lastOutputSequence: 0,
      cleanupCompleted: true,
      reportWritten: false,
      health: null,
    }) + '\n',
  );
}
process.exitCode ??= 2;
