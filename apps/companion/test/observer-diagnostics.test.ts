import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { unzipSync } from 'fflate';
import { startObserverProcess } from '../src/telemetry/observer-process.js';
import { SessionJournal } from '../src/support/session-journal.js';
import { SupportExports } from '../src/support/export-job.js';
import { technicalProjection } from '../src/support/technical-projection.js';

test('component failure survives local journal and actual support ZIP without credentials', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'mizar-observer-evidence-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const logs = join(root, 'logs');
  const reports = join(root, 'data', 'observer');
  await mkdir(logs);
  await mkdir(reports, { recursive: true });
  const outputDirectory = join(reports, randomUUID());
  const driver = fileURLToPath(new URL('./fixtures/observer-child.mjs', import.meta.url));
  const password = 'diagnostic-test-private-password';
  const owner = startObserverProcess({
    role: 'lookahead',
    python: process.execPath,
    driver,
    native: driver,
    steamApi: driver,
    node: process.execPath,
    parserWorker: driver,
    outputDirectory,
    hostVersion: 14197,
    endpoint: '127.0.0.25:27020',
    password,
  });
  t.after(() => owner.stop());
  const result = await owner.closed;
  assert.equal(result.failed, true);
  assert.match(result.terminal.detail ?? '', /unsupported serializer test_field/);
  assert(!JSON.stringify(result.terminal).includes(password));
  assert.equal(result.terminal.hostVersion, 14197);
  const journal = new SessionJournal(logs);
  t.after(() => journal.close());
  await journal.recordCommitted('observer_attempt_terminal', result.terminal);

  // A historical component report must survive even when its journal has rotated.
  const oldId = randomUUID();
  await mkdir(join(reports, oldId));
  await writeFile(
    join(reports, oldId, 'report.json'),
    JSON.stringify({
      schema: 'cs2-observer-report/1',
      reason: 'ordered-parser-error: historical_field',
      password,
      native_boot_code: 5,
      steam_init_result: 0,
      cleanupCompleted: true,
    }),
  );
  const exports = new SupportExports(logs, () => [journal.exportParticipant()]);
  const job = await exports.begin({}, {});
  t.after(() => exports.cancel(job.exportId));
  const deadline = Date.now() + 15_000;
  while (!exports.status(job.exportId)?.settled && Date.now() < deadline) await delay(20);
  const status = exports.status(job.exportId)!;
  assert.equal(status.phase, 'ready', status.error);
  assert.equal(status.settled, true);
  const entries = unzipSync(await readFile(join(exports.directory, job.exportId, 'part-1.zip')));
  const report = entries[`attachments/observer/${oldId}/report.json`];
  assert(report, Buffer.from(entries['coverage.json']!).toString());
  const attachment = JSON.parse(Buffer.from(report).toString());
  assert.equal(attachment.reason, 'ordered-parser-error: historical_field');
  assert.equal(attachment.password, '[redacted]');
  const events = Object.entries(entries)
    .filter(([name]) => name.startsWith('events/'))
    .flatMap(([, bytes]) =>
      Buffer.from(bytes)
        .toString()
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line)),
    );
  const terminal = events.find((event) => event.kind === 'observer_attempt_terminal');
  assert.match(terminal.evidence.detail, /unsupported serializer test_field/);
  assert(!Object.values(entries).some((bytes) => Buffer.from(bytes).includes(password)));
  const cloud = technicalProjection(terminal, '2020-01-01T00:00:00Z');
  assert.equal(cloud.evidence?.hostVersion, 14197);
  assert(!JSON.stringify(cloud).includes('unsupported serializer'));
});

test('support export rejects hard-linked or invalid observer reports and records the gaps', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'mizar-observer-report-boundary-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const logs = join(root, 'logs');
  const reports = join(root, 'data', 'observer');
  await mkdir(logs);
  await mkdir(reports, { recursive: true });
  const unsafeId = randomUUID(),
    invalidId = randomUUID();
  await mkdir(join(reports, unsafeId));
  await mkdir(join(reports, invalidId));
  const privateFile = join(root, 'unrelated.json');
  await writeFile(privateFile, '{"private":"unrelated-file-marker"}');
  await link(privateFile, join(reports, unsafeId, 'report.json'));
  await writeFile(join(reports, invalidId, 'report.json'), '{"schema":"unsupported"}');
  const exports = new SupportExports(logs);
  const job = await exports.begin({}, {});
  t.after(() => exports.cancel(job.exportId));
  const deadline = Date.now() + 15_000;
  while (!exports.status(job.exportId)?.settled && Date.now() < deadline) await delay(20);
  const status = exports.status(job.exportId)!;
  assert.equal(status.phase, 'ready', status.error);
  const entries = unzipSync(await readFile(join(exports.directory, job.exportId, 'part-1.zip')));
  assert(!Object.keys(entries).some((name) => name.startsWith('attachments/observer/')));
  const coverage = JSON.parse(Buffer.from(entries['coverage.json']!).toString());
  assert(
    coverage.gaps.some((gap: { reason: string }) => gap.reason.includes('resource_path_unsafe')),
  );
  assert(
    coverage.gaps.some((gap: { reason: string }) => gap.reason.includes('observer_report_schema')),
  );
  assert(
    !Object.values(entries).some((bytes) => Buffer.from(bytes).includes('unrelated-file-marker')),
  );
});
