#!/usr/bin/env node
// Synthetic process tree exercises the production Windows relay and Job ownership.
import { spawn } from 'node:child_process';
import process from 'node:process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
const args = process.argv.slice(2);
const output = args[args.indexOf('--output') + 1];
const input = createInterface({ input: process.stdin });
for await (const line of input) {
  JSON.parse(line);
  const worker = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { windowsHide: true, stdio: 'ignore' });
  mkdirSync(output, { recursive: true });
  writeFileSync(join(output, 'owned-pids.json'), JSON.stringify({ driver: process.pid, worker: worker.pid }));
  process.stdout.write(JSON.stringify({ kind: 'session-start', protocol: 3, channel: 1, world: 1, sequence: 1 }) + '\n');
  process.stdout.write(JSON.stringify({ kind: 'cursor', channel: 1, world: 1, sequence: 2, committedTick: 1, tickInterval: 1 / 64, map: 'de_test', warmup: false, round: 0 }) + '\n');
  input.once('close', () => {
    worker.once('exit', () => {
      process.stderr.write(JSON.stringify({
        schema: 'cs2-observer-report/3',
        outcome: 'stopped',
        reason: 'owner-stopped',
        channel: 1,
        world: 1,
        lastOutputSequence: 2,
        reconnects: 0,
        faults: [],
      }) + '\n');
      process.exitCode = 2;
    });
    worker.kill();
  });
}
