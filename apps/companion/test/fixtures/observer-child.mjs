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
for await (const text of inputLines) {
  const input = JSON.parse(text);
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
  try {
    fs.mkdirSync(arg('--output'), { mode: 0o700 });
  } catch {
    process.stderr.write('output-directory-unavailable\n');
    process.exit(1);
  }
  const v3Report = (reason, extra = {}) =>
    JSON.stringify({
      schema: 'cs2-observer-report/3',
      outcome: 'failed',
      reason,
      channel: 1,
      world: 1,
      lastOutputSequence: 0,
      reconnects: 0,
      faults: [],
      ...extra,
    });
  const earlyFailures = {
    '127.0.0.25:27020': v3Report('native-start-failed', {
      nativeBootCode: 5,
      steamInitResult: 0,
      phase: 'native-boot',
    }),
    '127.0.0.26:27020': 'interpreter-failure-prefix\n' + 'x'.repeat(64 * 1024) + input.password,
    '127.0.0.11:27020': 'output-directory-unavailable\nSynthetic shutdown diagnostic',
    '127.0.0.12:27020': 'configuration-boundary',
    '127.0.0.13:27020': 'Traceback private path and ' + input.password + '\nconfiguration-boundary',
    '127.0.0.14:27020': '',
    '127.0.0.15:27020': '{"schema":',
    '127.0.0.16:27020': 'private unknown stderr ' + input.password,
    '127.0.0.17:27020': v3Report(input.password),
    '127.0.0.21:27020': v3Report('native-start-failed') + '\nSynthetic shutdown diagnostic',
    '127.0.0.22:27020': v3Report('native-start-failed') + '\n{"malformed":',
    '127.0.0.23:27020': v3Report('native-start-failed') + '\n' + v3Report('initialization-timeout'),
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
    const health = {
      type: 'cs2-observer-health/3',
      channel: 1,
      world: 1,
      state: 'failed',
      reason: 'reconnect-budget-exhausted',
      reconnects: 0,
    };
    const report = {
      schema: 'cs2-observer-report/3',
      outcome: 'failed',
      reason: 'reconnect-budget-exhausted',
      channel: 1,
      world: 1,
      lastOutputSequence: 1,
      reconnects: 0,
      faults: [],
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
  const event = JSON.parse(
    fs.readFileSync(new URL('./observer-event.json', import.meta.url), 'utf8'),
  );
  const cursor = {
    kind: 'cursor',
    channel: 1,
    world: 1,
    sequence: 6,
    committedTick: 99,
    tickInterval: 1 / 64,
    map: 'de_test',
    warmup: false,
    round: 6,
  };
  process.stdout.write(JSON.stringify({ kind: 'session-start', protocol: 3, channel: 1, world: 1, sequence: 1 }) + '\n');
  process.stdout.write(JSON.stringify(cursor) + '\n');
  process.stdout.write(JSON.stringify({ ...event, world: 1, sequence: 7 }) + '\n');
  if (input.endpoint === '127.0.0.10:27020') {
    process.stderr.write(
      JSON.stringify({
        schema: 'cs2-observer-report/3',
        outcome: 'closed',
        reason: 'source-hltv-stop',
        channel: 1,
        world: 1,
        lastOutputSequence: 7,
        reconnects: 0,
        faults: [],
      }) + '\n',
    );
    process.exitCode = 0;
    inputLines.close();
    process.stdin.destroy();
    break;
  }
}
process.exitCode ??= 2;
