#!/usr/bin/env node
import process from 'node:process';
import { setInterval, setTimeout } from 'node:timers';
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
  if (input.endpoint === '127.0.0.29:27020' || input.endpoint === '127.0.0.30:27020') {
    const map = input.endpoint === '127.0.0.29:27020' ? 'de_dust2' : 'de_mirage';
    const round = input.endpoint === '127.0.0.29:27020' ? 6 : 0;
    const death = (channel, sequence, killerSlot, victimSlot) => ({
      kind: 'event',
      name: 'player_death',
      channel,
      world: 1,
      sequence,
      eventTick: 100 + sequence,
      committedTick: 100 + sequence,
      tickInterval: 1 / 64,
      map,
      warmup: false,
      round,
      fields: {
        userid: victimSlot,
        attacker: killerSlot,
        weapon: 'ak47',
        assistedflash: false,
        headshot: true,
        penetrated: 0,
        noscope: false,
        thrusmoke: false,
        attackerblind: false,
        attackerinair: false,
        distance: 10,
        dmg_health: 100,
        dmg_armor: 0,
        hitgroup: 1,
      },
      players: {
        attacker: {
          domain: 'player-controller-slot',
          slot: killerSlot,
          steamId: '76561198000000001',
          userId: 1,
          controller: { index: killerSlot + 1, serial: 1 },
        },
        userid: {
          domain: 'player-controller-slot',
          slot: victimSlot,
          steamId: '76561198000000002',
          userId: 2,
          controller: { index: victimSlot + 1, serial: 1 },
        },
      },
    });
    const out = (row) => process.stdout.write(JSON.stringify(row) + '\n');
    out({ kind: 'session-start', protocol: 3, channel: 1, world: 1, sequence: 1 });
    out({ kind: 'cursor', channel: 1, world: 1, sequence: 2, committedTick: 100, tickInterval: 1 / 64, map, warmup: false, round });
    out(death(1, 3, 0, 1));
    if (input.endpoint === '127.0.0.29:27020') {
      out({ kind: 'discontinuity', scope: 'connection', reason: 'network-drop', channel: 1, world: 1, sequence: 4 });
      out({ kind: 'session-start', protocol: 3, channel: 2, world: 1, sequence: 5 });
      out({ kind: 'cursor', channel: 2, world: 1, sequence: 6, committedTick: 200, tickInterval: 1 / 64, map, warmup: false, round });
      out(death(2, 7, 0, 1));
      out({ kind: 'discontinuity', scope: 'connection', reason: 'source-hltv-stop', channel: 2, world: 1, sequence: 8 });
      process.stderr.write(JSON.stringify({
        schema: 'cs2-observer-report/3',
        outcome: 'closed',
        reason: 'source-hltv-stop',
        channel: 2,
        world: 1,
        lastOutputSequence: 8,
        reconnects: 1,
        faults: [],
      }) + '\n');
      process.exitCode = 0;
      inputLines.close();
      process.stdin.destroy();
      break;
    }
    await new Promise((r) => setTimeout(r, 250));
    out({ kind: 'event', name: 'begin_new_match', channel: 1, world: 1, sequence: 4, eventTick: 110, committedTick: 110, tickInterval: 1 / 64, map, warmup: true, round: 0, fields: {}, players: {} });
    continue;
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
  if (input.endpoint === '127.0.0.31:27020') {
    process.exitCode = 0;
    inputLines.close();
    process.stdin.destroy();
    break;
  }
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
