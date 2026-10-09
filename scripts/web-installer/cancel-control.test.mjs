import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { URL } from 'node:url';
import { describe, it, expect } from 'vitest';

async function stdinCase(chunks, expected) {
  const moduleUrl = new URL('./cancel-control.mjs', import.meta.url).href;
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import {createCancelControl} from ${JSON.stringify(moduleUrl)};
    const controller=new AbortController();
    controller.signal.addEventListener('abort',()=>process.stdout.write('cancelled\\n'));
    const feed=createCancelControl(()=>controller.abort());
    process.stdin.on('data',bytes=>{feed(bytes);if(!controller.signal.aborted)process.stdout.write('part\\n');});
    process.stdin.on('end',()=>{if(!controller.signal.aborted)process.stdout.write('open\\n');});
    process.stdout.write('ready\\n');
  `,
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );
  const exited = once(child, 'exit');
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  try {
    expect((await lines.next()).value).toBe('ready');
    for (let index = 0; index < chunks.length; index++) {
      child.stdin.write(chunks[index]);
      // Acknowledge each actual pipe read before the next write, forcing chunk boundaries.
      expect((await lines.next()).value).toBe(
        index === chunks.length - 1 && expected === 'cancelled' ? 'cancelled' : 'part',
      );
    }
    child.stdin.end();
    if (expected === 'open') expect((await lines.next()).value).toBe('open');
    expect((await exited)[0]).toBe(0);
  } finally {
    if (child.exitCode === null) child.kill(); // Only this protocol-test process; no file writer.
  }
}
describe('actual native stdin cancellation bytes', () => {
  it.each([
    [Buffer.from('cancel\r\n')],
    [Buffer.from('can'), Buffer.from('cel\r'), Buffer.from('\n')],
    [Buffer.from('canc'), Buffer.from('el\n')],
  ])(
    'aborts on Windows CRLF or LF, including acknowledged split pipe reads %#',
    async (...chunks) => {
      await stdinCase(chunks, 'cancelled');
    },
  );
  it('keeps unrelated complete lines open', async () => {
    await stdinCase([Buffer.from('continue\r\n')], 'open');
  });
});
