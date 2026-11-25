#!/usr/bin/env node
// Synthetic process tree exercises the production Windows relay and Job ownership.
import { spawn } from 'node:child_process';
import process from 'node:process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
const args = process.argv.slice(2);
const output = args[args.indexOf('--output') + 1];
const source = args[args.indexOf('--source-role') + 1] + ':' + args[args.indexOf('--source-id') + 1];
const input = createInterface({ input: process.stdin });
for await (const line of input) {
  JSON.parse(line);
  const worker = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { windowsHide: true, stdio: 'ignore' });
  mkdirSync(output, { recursive: true });
  writeFileSync(join(output, 'owned-pids.json'), JSON.stringify({ driver: process.pid, worker: worker.pid }));
  process.stdout.write(JSON.stringify({ kind: 'cursor', source, channel: 1, world: 1, sequence: 1, tick: 1, tickInterval: 1 / 64, map: 'de_test' }) + '\n');
  input.once('close', () => {
    worker.once('exit', () => {
      process.stderr.write(JSON.stringify({
        schema: 'cs2-observer-report/2',
        outcome: 'incomplete',
        reason: 'owner-stopped',
        lastOutputSequence: 1,
        cleanupCompleted: true,
        reportWritten: true,
        health: { type: 'cs2-observer-health/2', source, channel: 1, world: 1, state: 'stopped', ready: true },
      }) + '\n');
      process.exitCode = 2;
    });
    worker.kill();
  });
}
