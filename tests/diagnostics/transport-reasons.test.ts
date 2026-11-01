import { strict as assert } from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DiagnosticDelivery } from '../../apps/companion/src/support/delivery.js';
import { SessionJournal } from '../../apps/companion/src/support/session-journal.js';

for (const reason of ['permit_budget', 'rate_limited', 'unknown_server_reason']) {
  test(`HTTP 429 ${reason} survives restart without acknowledging the batch`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mizar-transport-reason-'));
    let journal = new SessionJournal(directory);
    const fetcher: typeof fetch = async (input, init) => {
      if (String(input).endsWith('/enroll')) {
        const enrollment = JSON.parse(String(init?.body)) as { enrollmentId: string };
        return Response.json({
          installationId: enrollment.enrollmentId,
          token: 'public-test-receipt',
          expiresAt: Date.now() + 86400_000,
        });
      }
      return Response.json({ error: reason }, { status: 429 });
    };
    const open = () =>
      new DiagnosticDelivery(directory, journal, {
        endpoint: 'https://diagnostics.invalid',
        fetch: fetcher,
      }).initialize(false);
    let delivery = await open();
    try {
      await delivery.consent(true);
      journal.record('quota_probe', { operation: 'public-test-operation' });
      await journal.flush();
      await delivery.tick();
      const expected = {
        phase: 'permit',
        status: 429,
        reason: reason === 'unknown_server_reason' ? 'unconfirmed' : reason,
      };
      assert.deepEqual(delivery.status().transportFailure, expected);
      assert.equal(delivery.status().acknowledged, 0);
      assert.ok(delivery.status().queuedBatches > 0);
      await delivery.close();
      await journal.close();
      journal = new SessionJournal(directory);
      delivery = await open();
      assert.deepEqual(delivery.status().transportFailure, expected);
      assert.equal(delivery.status().consent, true);
      assert.equal(delivery.status().acknowledged, 0);
      assert.ok(delivery.status().queuedBatches > 0);
    } finally {
      await delivery.close();
      await journal.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}
