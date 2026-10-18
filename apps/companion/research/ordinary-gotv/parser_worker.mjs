// Local process protocol: adapted Demo bytes in; scalar events/checkpoints out.
// No networking, Steam credentials, arbitrary commands or rendering.
import { Readable } from 'node:stream';
import process from 'node:process';
import { viewerDecoder } from '@mizar/telemetry-cstv/viewer-research';

const send = (record) => {
  if (process.stdout.writableLength > 8 * 1024 ** 2) throw new Error('parser-output-budget');
  process.stdout.write(JSON.stringify(record) + '\n');
};
const decoder = viewerDecoder(
  (event) => send({ type: 'event', event }),
  (checkpoint) => send({ type: 'checkpoint', ...checkpoint }),
);
process.once('SIGTERM', () => decoder.cancel());
process.stdout.on('error', () => {
  decoder.cancel();
  process.exitCode = 1;
});
try {
  const outcome = await decoder.parse(Readable.toWeb(process.stdin));
  send({ type: 'end', status: outcome.status });
  if (outcome.status === 'error') process.exitCode = 1;
} catch {
  send({ type: 'error', code: 'parser-failed' });
  process.exitCode = 1;
}
