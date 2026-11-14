import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
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
import { errorEvidence } from '../src/updates/diagnostics.js';

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
  assert.match(result.terminal.detail ?? '', /root-cause-at-end/);
  assert(!JSON.stringify(result.terminal).includes(password));
  assert.equal(result.terminal.hostVersion, 14197);
  const journal = new SessionJournal(logs);
  t.after(() => journal.close());
  await journal.recordCommitted('observer_attempt_terminal', result.terminal);
  const ticket = randomUUID();
  const failure = Object.assign(
    new Error('download failed; password=' + password + '; expected catalog.json', {
      cause: new AggregateError(
        Array.from({ length: 8 }, (_, i) => new Error(`transport cause ${i}`)),
        'all sources failed',
      ),
    }),
    { path: 'C:\\Users\\operator\\Mizar\\catalog.json', outputTokenConfigured: true },
  );
  const validation = Object.assign(new Error(password), {
    name: 'ZodError',
    issues: [{ code: 'invalid_type', path: ['password'], input: password, expected: 'string' }],
  });
  await journal.recordCommitted('local_diagnostic_context', {
    outputTokenConfigured: true,
    gsiTokenConfigured: false,
    connection: { passwordProvided: true, password },
    ticket,
    error: errorEvidence(failure),
    validation: errorEvidence(new Error('configuration validation', { cause: validation })),
    nested: { kind: 'program_all_chat', evidence: { text: 'private-chat-marker' } },
  });
  await journal.recordCommitted('cs2_console_records', {
    readError: 'file_changed_after_read',
    cursor: 714,
    records: [{ sourceRecordId: 'console-test-record', text: 'synthetic engine failure' }],
  });

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
  assert.match(terminal.evidence.detail, /root-cause-at-end/);
  const context = events.find((event) => event.kind === 'local_diagnostic_context').evidence;
  assert.equal(context.outputTokenConfigured, true);
  assert.equal(context.gsiTokenConfigured, false);
  assert.equal(context.connection.passwordProvided, true);
  assert.equal(context.connection.password, '[redacted]');
  assert.equal(
    context.ticket,
    `[redacted-ticket:${createHash('sha256').update(ticket).digest('hex')}]`,
  );
  assert.match(context.error.message, /expected catalog.json/);
  assert.equal(context.error.cause.errors[7].message, 'transport cause 7');
  assert.equal(context.error.path, failure.path);
  assert.equal(context.validation.cause.issues[0].code, 'invalid_type');
  const consoleContext = events.find(
    (event) => event.kind === 'console_carrier_reference',
  ).evidence;
  assert.equal(consoleContext.readError, 'file_changed_after_read');
  assert.equal(consoleContext.cursor, 714);
  assert.equal(consoleContext.eventRefs.length, 1);
  assert(!Object.values(entries).some((bytes) => Buffer.from(bytes).includes(password)));
  assert(!Object.values(entries).some((bytes) => Buffer.from(bytes).includes(ticket)));
  assert(
    !Object.values(entries).some((bytes) => Buffer.from(bytes).includes('private-chat-marker')),
  );
  const cloud = technicalProjection(terminal, '2020-01-01T00:00:00Z');
  assert.equal(cloud.evidence?.hostVersion, 14197);
  assert(!JSON.stringify(cloud).includes('unsupported serializer'));
});

test('pre-report and protocol failures survive the real export; overflow retains a prefix and a gap', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'mizar-observer-stream-evidence-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const logs = join(root, 'logs');
  const reports = join(root, 'data', 'observer');
  await mkdir(logs);
  await mkdir(reports, { recursive: true });
  const driver = fileURLToPath(new URL('./fixtures/observer-child.mjs', import.meta.url));
  const password = 'diagnostic-stream-private-password';
  const journal = new SessionJournal(logs);
  t.after(() => journal.close());
  for (const host of [13, 26, 27]) {
    const owner = startObserverProcess({
      role: 'lookahead',
      python: process.execPath,
      driver,
      native: driver,
      steamApi: driver,
      node: process.execPath,
      parserWorker: driver,
      outputDirectory: join(reports, randomUUID()),
      hostVersion: 14197,
      endpoint: `127.0.0.${host}:27020`,
      password,
    });
    t.after(() => owner.stop());
    const { terminal } = await owner.closed;
    await journal.recordCommitted('observer_attempt_terminal', terminal);
  }
  const exports = new SupportExports(logs, () => [journal.exportParticipant()]);
  const job = await exports.begin({}, {});
  t.after(() => exports.cancel(job.exportId));
  const deadline = Date.now() + 15_000;
  while (!exports.status(job.exportId)?.settled && Date.now() < deadline) await delay(20);
  const status = exports.status(job.exportId)!;
  assert.equal(status.phase, 'ready', status.error);
  const entries = unzipSync(await readFile(join(exports.directory, job.exportId, 'part-1.zip')));
  const events = Object.entries(entries)
    .filter(([name]) => name.startsWith('events/'))
    .flatMap(([, bytes]) =>
      Buffer.from(bytes)
        .toString()
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line)),
    );
  const failures = events
    .filter((event) => event.kind === 'observer_attempt_terminal')
    .map((event) => event.evidence);
  assert(
    failures.some((failure) =>
      failure.stderr.text.includes('Traceback private path and [redacted]'),
    ),
  );
  assert(
    failures.some(
      (failure) => failure.stdout.error?.name === 'SyntaxError' && failure.stdout.error.stack,
    ),
  );
  const overflow = failures.find((failure) => failure.stderr.truncated);
  assert(overflow.stderr.text.startsWith('interpreter-failure-prefix'));
  assert(overflow.stderr.observedBytes > overflow.stderr.retainedBytes);
  const coverage = JSON.parse(Buffer.from(entries['coverage.json']!).toString());
  assert(coverage.gaps.some((gap: { reason: string }) => gap.reason === 'observer_stderr_budget'));
  assert(!Object.values(entries).some((bytes) => Buffer.from(bytes).includes(password)));
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
