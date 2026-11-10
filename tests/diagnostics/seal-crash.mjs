// Isolated synthetic crash at the production seal-to-manifest durability boundary.
import process from 'node:process';
import { open, unlink } from 'node:fs/promises';
import { SessionJournal } from '../../apps/companion/src/support/session-journal.ts';
import { DiagnosticDelivery } from '../../apps/companion/src/support/delivery.ts';
const { fetch } = globalThis;
const [endpoint, directory, timestamp, mode] = process.argv.slice(2);
const now = Number(timestamp);
const RealDate = Date;
globalThis.Date = new Proxy(RealDate, {
  construct: (target, args) => Reflect.construct(target, args.length ? args : [now]),
  get: (target, key) => (key === 'now' ? () => now : Reflect.get(target, key)),
});
const journal = new SessionJournal(directory, { appVersion: '1.4.0' });
const delivery = await new DiagnosticDelivery(directory, journal, {
  endpoint,
  allowTestEndpoint: true,
  now: () => now,
  fetch: (input, init) =>
    fetch(input, { ...init, headers: { ...init.headers, 'cf-connecting-ip': '192.0.2.8' } }),
}).initialize(false);
const save = delivery.save.bind(delivery);
delivery.save = async () => {
  if (mode !== 'partial' && delivery.state.queue.some((batch) => batch.sealed)) {
    // The production path has already written, fsynced and closed the sealed
    // file, but has not committed its reference. No graceful cleanup may run.
    process.kill(process.pid, 'SIGKILL');
    await new Promise(() => {});
  }
  return save();
};
if (mode === 'partial') {
  const probe = await open(directory + '/crash-probe', 'wx');
  const prototype = Object.getPrototypeOf(probe);
  await probe.close();
  await unlink(directory + '/crash-probe');
  const writeFile = prototype.writeFile;
  prototype.writeFile = async function (bytes, ...args) {
    if (bytes instanceof Uint8Array && bytes[0] === 31 && bytes[1] === 139 && bytes[3] === 4) {
      await writeFile.call(this, bytes.subarray(0, Math.floor(bytes.length / 2)), ...args);
      process.kill(process.pid, 'SIGKILL');
      await new Promise(() => {});
    }
    return writeFile.call(this, bytes, ...args);
  };
}
await delivery.consent(true);
journal.record('workspace_exit_begin', { synthetic: true, before: { workspace: 'active' } });
await journal.flush();
await delivery.tick();
throw new Error('seal crash boundary was not reached');
