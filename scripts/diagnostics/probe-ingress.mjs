// Explicit maintainer smoke: a synthetic, opted-in identity through the real
// client and public domestic ingress. Never reads an installed user's state.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { URL } from 'node:url';
import { SessionJournal } from '../../apps/companion/src/support/session-journal.ts';
import { DiagnosticDelivery } from '../../apps/companion/src/support/delivery.ts';
import { readAppVersion } from '../qualification/app-version.mjs';

const [mode, output] = process.argv.slice(2);
assert(mode === '--production' && output, 'Usage: probe-ingress.mjs --production <report.json>');
assert(
  process.env.NODE_USE_ENV_PROXY !== '1' && !/--use-env-proxy/.test(process.env.NODE_OPTIONS ?? ''),
  'Probe must use direct networking',
);
const endpoint = 'https://diagnostics.starfie1d.top';
const state = await mkdtemp(join(tmpdir(), 'mizar-public-ingress-probe-'));
const journal = new SessionJournal(state, {
  appVersion: await readAppVersion(),
});
const requests = [];
const report = { endpoint, synthetic: true, result: 'FAIL', requests, state };
const delivery = await new DiagnosticDelivery(state, journal, {
  endpoint,
  participants: () => [],
  fetch: async (input, init) => {
    const started = performance.now();
    const response = await globalThis.fetch(input, init);
    requests.push({
      method: init.method,
      path: new URL(String(input)).pathname,
      status: response.status,
      elapsedMs: Math.round(performance.now() - started),
    });
    return response;
  },
}).initialize(false);
try {
  await delivery.consent(true);
  await journal.recordCommitted('operation_result', {
    result: 'success',
    purpose: 'synthetic domestic ingress acceptance',
  });
  await delivery.tick();
  report.upload = delivery.status();
  const manifest = JSON.parse(await readFile(join(state, 'diagnostic-outbox/state.json'), 'utf8'));
  report.installationId = manifest.credentials.installationId;
  assert(
    report.upload.acknowledged > 0,
    `No persisted ACK: ${JSON.stringify(report.upload.transportFailure)}`,
  );
  assert(requests.some((request) => request.method === 'PUT' && request.status === 200));
  report.result = 'PASS';
} catch (error) {
  report.error = String(error);
} finally {
  // Revoke only this probe's independent identity, including on failed uploads.
  // Preserve the state directory if deletion is unconfirmed so it can be retried.
  try {
    await delivery.consent(false);
    await delivery.tick(false);
    report.withdrawal = delivery.status();
    assert.equal(report.withdrawal.deletionPending, 0, 'Probe withdrawal remains unconfirmed');
  } catch (error) {
    report.result = 'FAIL';
    report.cleanupError = String(error);
  }
  await delivery.close();
  await journal.close();
  await mkdir(dirname(resolve(output)), { recursive: true });
  await writeFile(resolve(output), JSON.stringify(report, null, 2) + '\n');
}
assert.equal(report.result, 'PASS', 'Inspect the report and retained probe state');
console.log(
  JSON.stringify({
    result: report.result,
    installationId: report.installationId,
    acknowledged: report.upload.acknowledged,
    deletionPending: report.withdrawal.deletionPending,
    requests,
  }),
);
