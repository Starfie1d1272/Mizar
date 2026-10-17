import { strict as assert } from 'node:assert';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Buffer } from 'node:buffer';
import { URL } from 'node:url';
import { SessionJournal } from '../../apps/companion/src/support/session-journal.ts';
import {
  DiagnosticDelivery,
  decodeDiagnosticBatch,
  DELIVERY_LIMITS,
} from '../../apps/companion/src/support/delivery.ts';
import {
  diagnosticInstallationCreatedAt,
  readDiagnosticGzipPermit,
} from '../../packages/protocol/src/diagnostics-upload.ts';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const { Response, Headers } = globalThis;

/** Admission belongs to the real journal/outbox. This focused boundary probe
 * uses deterministic protocol receipts; real server quotas and storage are
 * independently exercised by the multi-day HTTP scenario. No state injection. */
export async function fullOutbox(directory) {
  const reports = [];
  for (const boundary of ['bytes', 'batches']) {
    const path = await mkdtemp(join(directory, `full-${boundary}-`));
    let journal;
    let delivery;
    let installation;
    const received = new Set();
    const originalPayloads = new Set();
    const state = async () =>
      JSON.parse(await readFile(join(path, 'diagnostic-outbox/state.json'), 'utf8'));
    const fetcher = async (input, init) => {
      const url = new URL(input);
      if (url.pathname.endsWith('/enroll')) {
        installation = JSON.parse(init.body).enrollmentId;
        return Response.json({
          installationId: installation,
          token: 'public-boundary-receipt',
          expiresAt: Date.now() + 86400_000,
        });
      }
      if (url.pathname.includes('/permits/')) {
        const issuedAt = Date.now();
        return Response.json({
          schema: 'mizar-diagnostic-permit/2',
          installationId: installation,
          installationCreatedAt: diagnosticInstallationCreatedAt(installation),
          consentRevision: 'technical-diagnostics-v3',
          payloadSha256: url.pathname.split('/').at(-1),
          payloadCreatedAt: Number(new Headers(init.headers).get('x-diagnostics-created-at')),
          issuedAt,
          expiresAt: issuedAt + 7 * 86400_000,
          signature: 'a'.repeat(43),
        });
      }
      assert.equal(init.method, 'PUT');
      const bytes = Buffer.from(init.body);
      const sealed = readDiagnosticGzipPermit(bytes);
      assert(sealed);
      assert.equal(hash(sealed.payload), sealed.permit.payloadSha256);
      originalPayloads.add(hash(sealed.payload));
      for (const event of (await decodeDiagnosticBatch(bytes)).events)
        if (event.stage === 'outbox_capacity') received.add(event.evidence.index);
      const id = hash(bytes);
      return Response.json({ accepted: true, batchId: id, sha256: id });
    };
    const open = async () => {
      journal = new SessionJournal(path);
      delivery = await new DiagnosticDelivery(path, journal, {
        endpoint: 'https://capacity.invalid',
        fetch: fetcher,
      }).initialize(false);
    };
    const close = async () => {
      await delivery.close();
      await journal.close();
    };
    try {
      await open();
      await delivery.consent(true);
      await delivery.pause(true);
      let offered = 0;
      while (delivery.status().error !== 'queue_budget_local_journal_retained') {
        assert(offered < 6000, 'production admission did not enforce the configured boundary');
        const count = boundary === 'bytes' ? 32 : 1;
        for (let i = 0; i < count; i++) {
          journal.record('outbox_capacity', {
            index: offered++,
            text:
              boundary === 'bytes'
                ? randomBytes(24000).toString('base64')
                : 'public count boundary',
          });
        }
        await journal.flush();
        await delivery.tick();
      }
      const full = delivery.status();
      assert(full.queuedBytes <= DELIVERY_LIMITS.queueBytes);
      assert(full.queuedBatches <= DELIVERY_LIMITS.batches);
      if (boundary === 'bytes')
        assert(full.queuedBytes > DELIVERY_LIMITS.queueBytes - DELIVERY_LIMITS.compressedBytes);
      else assert.equal(full.queuedBatches, DELIVERY_LIMITS.batches);
      const before = new Map();
      for (const batch of (await state()).queue) {
        const bytes = await readFile(join(path, 'diagnostic-outbox', batch.id + '.gz'));
        assert.equal(hash(bytes), batch.id);
        before.set(batch.id, bytes);
      }
      // Full admission must retain every existing byte and defer this new record.
      journal.record('outbox_capacity', {
        index: offered++,
        text: 'pending across restart at full capacity',
      });
      await journal.flush();
      await delivery.tick();
      await close();
      await open();
      const restored = new Set((await state()).queue.map((batch) => batch.id));
      for (const [id, bytes] of before) {
        assert(restored.has(id));
        assert(bytes.equals(await readFile(join(path, 'diagnostic-outbox', id + '.gz'))));
      }
      await delivery.pause(false);
      for (
        let ticks = 0;
        ticks < DELIVERY_LIMITS.batches + 50 &&
        (received.size < offered ||
          delivery.status().queuedBatches ||
          delivery.status().pendingBytes);
        ticks++
      ) {
        await journal.flush();
        await delivery.tick();
      }
      assert.equal(
        received.size,
        offered,
        'capacity release failed to recover retained source records',
      );
      assert(
        [...before.keys()].every((id) => originalPayloads.has(id)),
        'an unacknowledged original was replaced',
      );
      assert.equal(delivery.status().queuedBatches, 0);
      assert.equal(delivery.status().pendingBytes, 0);
      assert.equal(delivery.status().omitted, 0);
      reports.push({
        boundary,
        offeredRecords: offered,
        peakBatches: full.queuedBatches,
        peakBytes: full.queuedBytes,
        retainedOriginals: before.size,
        allOriginalBytesPreserved: true,
        recoveredRecords: received.size,
        finalBacklog: 0,
        scope:
          'actual SessionJournal admission, default production 64 MiB/2048-batch outbox, full queue/restart/drain; protocol receipt fixture, not remote capacity',
      });
    } finally {
      await close();
      await rm(path, { recursive: true, force: true });
    }
  }
  return reports;
}
