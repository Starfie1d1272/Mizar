import process from 'node:process';
import { setInterval } from 'node:timers';
import { URL } from 'node:url';
// Synthetic local child: no SDK, network or game process.
import fs from 'node:fs';
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
  if (input.endpoint === '127.0.0.2:27020') process.exit(7);
  if (input.endpoint === '127.0.0.4:27020') process.exit(2);
  if (input.endpoint === '127.0.0.3:27020') {
    process.stdout.write('{bad}\n');
    setInterval(() => {}, 1000);
    await new Promise(() => {});
  }
  const source = arg('--source-role') + ':' + arg('--source-id');
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
}
process.exit(2);
