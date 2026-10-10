import { Buffer } from 'node:buffer';
import { StringDecoder } from 'node:string_decoder';

/** Bounded native stdin protocol; Windows CRLF and LF may arrive in separate chunks. */
export function createCancelControl(cancel) {
  const decoder = new StringDecoder('utf8');
  let pending = '',
    bytes = 0,
    closed = false;
  return (chunk) => {
    if (closed) return;
    const input = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8');
    bytes += input.length;
    pending += decoder.write(input);
    let newline;
    while ((newline = pending.indexOf('\n')) !== -1) {
      const line = pending.slice(0, newline).replace(/\r$/, '');
      pending = pending.slice(newline + 1);
      if (line === 'cancel') {
        closed = true;
        cancel();
        return;
      }
    }
    if (bytes > 64) {
      closed = true;
      cancel();
    }
  };
}
