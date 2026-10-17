import { DIAGNOSTIC_BODY_LIFETIME_MS } from '@mizar/protocol/diagnostics-upload';
import { mkdtemp, readFile, readdir, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DiagnosticDelivery,
  decodeDiagnosticBatch,
  diagnosticsEndpoint,
} from '../src/support/delivery.js';
import { SessionJournal } from '../src/support/session-journal.js';
vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof import('node:fs/promises')>()),
}));
import * as filesystem from 'node:fs/promises';
interface DiskState {
  consent: boolean;
  credentials: { installationId: string; enrollmentSecret: string };
  queue: unknown[];
  acknowledged: number;
  sessions: Record<string, { from: number; queued: number }>;
}
const paths: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(paths.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});
async function directory() {
  const p = await mkdtemp(join(tmpdir(), 'mizar-delivery-'));
  paths.push(p);
  return p;
}
const secret = '1'.repeat(64);
function service(clock = Date.now) {
  const batches = new Map<string, Uint8Array>();
  const calls: string[] = [];
  let offline = false;
  let loseAcknowledgment = false;
  let revoked = false;
  let installation = '';
  const fetcher: typeof fetch = async (input, init) => {
    if (offline) throw new TypeError('offline');
    const url = new URL(
      input instanceof Request ? input.url : input instanceof URL ? input.href : input,
    );
    calls.push(`${init?.method} ${url.pathname}`);
    if (url.pathname.endsWith('/enroll')) {
      const data = JSON.parse(init?.body as string) as { enrollmentId: string };
      installation = data.enrollmentId;
      return Response.json({
        installationId: data.enrollmentId,
        token: 'test-token',
        expiresAt: Date.now() + 30 * 86400_000,
      });
    }
    if (url.pathname.includes('/permits/')) {
      const issuedAt = clock();
      return Response.json({
        schema: 'mizar-diagnostic-permit/2',
        installationCreatedAt: 0,
        consentRevision: 'technical-diagnostics-v3',
        installationId:
          installation ||
          (JSON.parse(await readFile(currentState(), 'utf8')) as DiskState).credentials
            .installationId,
        payloadSha256: url.pathname.split('/').at(-1),
        payloadCreatedAt: Number(new Headers(init?.headers).get('x-diagnostics-created-at')),
        issuedAt,
        expiresAt: issuedAt + DIAGNOSTIC_BODY_LIFETIME_MS,
        signature: 'a'.repeat(43),
      });
    }
    if (init?.method === 'DELETE') {
      revoked = true;
      batches.clear();
      return Response.json({
        installationId: (
          JSON.parse(await readFile(currentState(), 'utf8')) as {
            withdrawals: { installationId: string }[];
          }
        ).withdrawals[0]!.installationId,
        revoked: true,
        deletion: 'complete',
      });
    }
    const id = url.pathname.split('/').at(-1)!;
    batches.set(id, new Uint8Array(init?.body as Uint8Array));
    if (loseAcknowledgment) {
      loseAcknowledgment = false;
      throw new TypeError('acknowledgment lost');
    }
    return Response.json({ batchId: id, sha256: id, accepted: true });
  };
  let statePath = '';
  const currentState = () => statePath;
  return {
    batches,
    calls,
    fetcher,
    setOffline: (v: boolean) => (offline = v),
    loseAck: () => (loseAcknowledgment = true),
    revoked: () => revoked,
    setState: (p: string) => (statePath = p),
  };
}
describe('consented diagnostic outbox', () => {
  it('rolls back failed identity renewal and confirms retired closure after restart instead of inferring it from time', async () => {
    const dir = await directory();
    const path = join(dir, 'diagnostic-outbox/state.json');
    const born = Date.now();
    let now = born;
    let online = true;
    let failClosure = true;
    const remote = service(() => now);
    remote.setState(path);
    const fetcher: typeof fetch = async (input, init) => {
      if (!online) throw new TypeError('public offline test');
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.pathname.endsWith('/enroll')) {
        const data = JSON.parse(init?.body as string) as {
          enrollmentId: string;
          deletion?: boolean;
        };
        if (data.deletion) {
          if (failClosure)
            return Response.json({
              installationId: 'wrong-identity',
              closed: true,
              revoked: true,
              deletion: 'complete',
            });
          return Response.json({
            installationId: data.enrollmentId,
            closed: true,
            revoked: true,
            deletion: 'complete',
          });
        }
      }
      return remote.fetcher(input, init);
    };
    const options = { endpoint: 'https://diagnostics.example', fetch: fetcher, now: () => now };
    let journal = new SessionJournal(dir);
    let delivery = await new DiagnosticDelivery(dir, journal, options).initialize(false);
    const state = async () =>
      JSON.parse(await readFile(path, 'utf8')) as {
        credentials: { installationId: string };
        queue: { id: string; serverExpired?: boolean }[];
        withdrawals: { installationId: string }[];
        retiredIdentities: { installationId: string }[];
      };
    try {
      await delivery.consent(true);
      journal.record('normal_operation', { result: 'first identity enrolled' });
      await journal.flush();
      await delivery.tick();
      online = false;
      journal.record('normal_operation', { result: 'retained original' });
      await journal.flush();
      await delivery.tick();
      const before = await state();
      const original = await readFile(join(dir, `diagnostic-outbox/${before.queue[0]!.id}.gz`));
      now = born + 90 * 86400_000 + 1000;
      const failed = vi
        .spyOn(filesystem, 'rename')
        .mockImplementationOnce((...args) =>
          Promise.reject(
            Object.assign(
              new Error(
                args[1] === path
                  ? 'public renewal manifest EIO'
                  : 'unexpected rename before renewal',
              ),
              { code: 'EIO' },
            ),
          ),
        );
      await expect(delivery.tick()).rejects.toThrow('renewal manifest EIO');
      failed.mockRestore();
      expect((await state()).credentials.installationId).toBe(before.credentials.installationId);
      expect((await state()).queue[0]).toEqual(before.queue[0]);
      await delivery.tick();
      expect((await state()).credentials.installationId).not.toBe(
        before.credentials.installationId,
      );
      expect(await readFile(join(dir, `diagnostic-outbox/${before.queue[0]!.id}.gz`))).toEqual(
        original,
      );
      await delivery.close();
      await journal.close();
      now = born + 181 * 86400_000;
      journal = new SessionJournal(dir);
      delivery = await new DiagnosticDelivery(dir, journal, options).initialize(false);
      online = true;
      await delivery.tick();
      expect((await state()).withdrawals).toContainEqual(
        expect.objectContaining({ installationId: before.credentials.installationId }),
      );
      expect(delivery.status().deletionPending).toBeGreaterThan(0);
      failClosure = false;
      now += 86400_000;
      await delivery.tick();
      expect((await state()).withdrawals).not.toContainEqual(
        expect.objectContaining({ installationId: before.credentials.installationId }),
      );
      expect(delivery.status().deletionPending).toBe(0);
      expect(await readFile(join(dir, `diagnostic-outbox/${before.queue[0]!.id}.gz`))).toEqual(
        original,
      );
    } finally {
      await delivery.close();
      await journal.close();
    }
  });
  it('defaults off, does not backfill pre-consent history, and preserves technical context without credentials', async () => {
    const dir = await directory();
    const journal = new SessionJournal(dir);
    const remote = service();
    const delivery = await new DiagnosticDelivery(dir, journal, {
      endpoint: 'https://diagnostics.example',
      fetch: remote.fetcher,
    }).initialize(false);
    journal.record('operation_result', { result: 'before-consent' });
    await journal.flush();
    await delivery.tick();
    expect(remote.calls).toEqual([]);
    await delivery.consent(true);
    journal.record('performance_anomaly_samples', {
      id: 'public-window',
      phase: 'before',
      samples: [
        {
          time: new Date(Date.now() - 86400_000).toISOString(),
          evidence: 'private-pre-consent-sample',
        },
        { time: new Date(Date.now() + 1000).toISOString(), evidence: 'permitted-after-consent' },
        { time: 'invalid', evidence: 'unknown-source-time' },
      ],
    });
    journal.record('performance_anomaly_begin', {
      originalPrivateContext: 'private-recovered-before-consent',
      sourceRecord: { time: new Date(Date.now() - 86400_000).toISOString() },
    });
    journal.record('native_host_records', {
      entries: [
        {
          entry: {
            time: new Date(Date.now() - 86400_000).toISOString(),
            stage: 'process_start',
            detail: 'private-native-before-consent',
          },
        },
        {
          entry: {
            time: new Date(Date.now() + 1000).toISOString(),
            stage: 'workspace_exit_wait',
            detail: 'permitted-native-after-consent',
          },
        },
        {
          entry: {
            time: new Date(Date.now() + 1000).toISOString(),
            stage: 'private_chat',
            detail: 'never-upload-native-chat',
          },
        },
      ],
    });
    journal.record('operation_result', {
      result: 'confirmed',
      route: '/operator/music/config',
      password: secret,
      error: new Error('network token=private-token'),
      chatText: 'private-chat',
    });
    await journal.flush();
    await delivery.tick();
    expect(remote.batches.size).toBe(1);
    const decoded = await decodeDiagnosticBatch(Buffer.from([...remote.batches.values()][0]!));
    const text = JSON.stringify(decoded);
    expect(text).toContain('confirmed');
    expect(text).toContain('/operator/music/config');
    expect(text).not.toContain('before-consent');
    expect(text).not.toContain(secret);
    expect(text).not.toContain('private-token');
    expect(text).not.toContain('private-chat');
    expect(text).not.toContain('private-pre-consent-sample');
    expect(text).not.toContain('unknown-source-time');
    expect(text).not.toContain('private-recovered-before-consent');
    expect(text).toContain('recovered_source_before_consent_or_unknown_time');
    expect(text).toContain('permitted-after-consent');
    expect(text).toContain('excludedPreConsentOrUnknownTimeSamples');
    expect(text).not.toContain('private-native-before-consent');
    expect(text).not.toContain('never-upload-native-chat');
    expect(text).toContain('permitted-native-after-consent');
    expect(text).toContain('excludedPreConsentUnknownTimeOrChatRecords');
    expect(await readFile(join(dir, 'session.ndjson'), 'utf8')).toContain(
      'private-pre-consent-sample',
    );
    expect(delivery.status().acknowledged).toBe(1);
    await delivery.close();
    await journal.close();
  });
  it('keeps offline batches across restart, recovers source journal records and retries an identical accepted batch after lost acknowledgment', async () => {
    const dir = await directory();
    const remote = service(() => now);
    let now = Date.now();
    const options = {
      endpoint: 'https://diagnostics.example',
      fetch: remote.fetcher,
      now: () => now,
    };
    let journal = new SessionJournal(dir);
    let delivery = await new DiagnosticDelivery(dir, journal, options).initialize(false);
    await delivery.consent(true);
    remote.setOffline(true);
    journal.record('operation_result', { result: 'accepted' });
    await journal.flush();
    await delivery.tick();
    expect(delivery.status().queuedBatches).toBe(1);
    await delivery.close();
    // A durable source event committed after the observer stopped must be recovered.
    journal.record('operation_result', { result: 'recovered-after-restart' });
    await journal.close();
    journal = new SessionJournal(dir);
    delivery = await new DiagnosticDelivery(dir, journal, options).initialize(false);
    now += 8 * 3600_000;
    remote.setOffline(false);
    remote.loseAck();
    await delivery.tick();
    const acceptedId = [...remote.batches.keys()][0];
    expect(delivery.status().queuedBatches).toBeGreaterThan(0);
    now += 8 * 3600_000;
    await delivery.tick();
    expect([...remote.batches.keys()][0]).toBe(acceptedId);
    for (let i = 0; i < 4; i++) await delivery.tick();
    const texts = await Promise.all(
      [...remote.batches.values()].map(async (b) =>
        JSON.stringify(await decodeDiagnosticBatch(Buffer.from(b))),
      ),
    );
    expect(texts.join('')).toContain('recovered-after-restart');
    expect(delivery.status().queuedBatches).toBe(0);
    await delivery.close();
    await journal.close();
  });
  it('withdraws immediately, persists offline deletion intent, removes queued content and confirms remote deletion after restart', async () => {
    const dir = await directory();
    const journal = new SessionJournal(dir);
    const remote = service();
    const state = join(dir, 'diagnostic-outbox/state.json');
    remote.setState(state);
    let delivery = await new DiagnosticDelivery(dir, journal, {
      endpoint: 'https://diagnostics.example',
      fetch: remote.fetcher,
    }).initialize(false);
    await delivery.consent(true);
    journal.record('operation_result', { result: 'uploaded' });
    await journal.flush();
    await delivery.tick();
    expect(remote.batches.size).toBe(1);
    remote.setOffline(true);
    await delivery.consent(false);
    journal.record('operation_result', { result: 'after-withdrawal' });
    await journal.flush();
    await delivery.tick();
    expect(delivery.status()).toMatchObject({
      consent: false,
      queuedBatches: 0,
      deletionPending: 1,
    });
    expect(
      (await readdir(join(dir, 'diagnostic-outbox'))).filter((n) => n.endsWith('.gz')),
    ).toEqual([]);
    await delivery.close();
    delivery = await new DiagnosticDelivery(dir, journal, {
      endpoint: 'https://diagnostics.example',
      fetch: remote.fetcher,
      now: () => Date.now() + 86400_000,
    }).initialize(false);
    remote.setOffline(false);
    await delivery.tick();
    expect(remote.revoked()).toBe(true);
    expect(delivery.status().deletionPending).toBe(0);
    expect(remote.batches.size).toBe(0);
    await delivery.close();
    await journal.close();
  });
  it('does not accept false receipts, does not send while unconfigured, rejects unsafe state and bounded-decodes hostile archives', async () => {
    const dir = await directory();
    const journal = new SessionJournal(dir);
    const local = await new DiagnosticDelivery(dir, journal).initialize(false);
    await local.consent(true);
    journal.record('operation_result', { result: 'local-only' });
    await journal.flush();
    await local.tick();
    expect(local.status()).toMatchObject({ configured: false, queuedBatches: 1, acknowledged: 0 });
    await local.close();
    await journal.close();
    expect(() => diagnosticsEndpoint('http://example.com')).toThrow();
    expect(() => diagnosticsEndpoint('https://user:pass@example.com')).toThrow();
    await expect(
      decodeDiagnosticBatch(
        gzipSync(
          Buffer.from(
            JSON.stringify({
              schema: 'mizar-technical-diagnostics/1',
              events: [{ text: 'a'.repeat(3 * 1024 * 1024) }],
            }),
          ),
        ),
      ),
    ).rejects.toMatchObject({ code: 'ERR_BUFFER_TOO_LARGE' });
    const bad = await directory();
    await writeFile(join(bad, 'outside.json'), '{}');
    await import('node:fs/promises').then((fs) => fs.mkdir(join(bad, 'diagnostic-outbox')));
    await symlink(join(bad, 'outside.json'), join(bad, 'diagnostic-outbox/state.json'));
    const badJournal = new SessionJournal(bad);
    try {
      await expect(new DiagnosticDelivery(bad, badJournal).initialize(false)).rejects.toThrow();
    } finally {
      await badJournal.close();
    }
  });
  it('retains a batch after a false receipt and stops an in-flight upload immediately on revocation', async () => {
    const dir = await directory();
    const journal = new SessionJournal(dir);
    let uploads = 0;
    let mode: 'false-ack' | 'block' = 'false-ack';
    let entered!: () => void;
    const started = new Promise<void>((r) => (entered = r));
    let installation = '';
    const fetcher: typeof fetch = async (input, init) => {
      if (
        (input instanceof Request ? input.url : input instanceof URL ? input.href : input).endsWith(
          '/enroll',
        )
      ) {
        const data = JSON.parse(init?.body as string) as { enrollmentId: string };
        installation = data.enrollmentId;
        return Response.json({
          installationId: data.enrollmentId,
          token: 'test-token',
          expiresAt: Date.now() + 30 * 86400_000,
        });
      }
      const path = new URL(
        input instanceof Request ? input.url : input instanceof URL ? input.href : input,
      ).pathname;
      if (path.includes('/permits/')) {
        const issuedAt = Date.now();
        return Response.json({
          schema: 'mizar-diagnostic-permit/2',
          installationCreatedAt: 0,
          consentRevision: 'technical-diagnostics-v3',
          installationId: installation,
          payloadSha256: path.split('/').at(-1),
          payloadCreatedAt: Number(new Headers(init?.headers).get('x-diagnostics-created-at')),
          issuedAt,
          expiresAt: issuedAt + DIAGNOSTIC_BODY_LIFETIME_MS,
          signature: 'a'.repeat(43),
        });
      }
      uploads++;
      if (mode === 'false-ack')
        return Response.json({ accepted: true, batchId: 'incorrect', sha256: 'incorrect' });
      entered();
      return new Promise<Response>((_resolve, reject) =>
        init!.signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true }),
      );
    };
    let now = Date.now();
    const delivery = await new DiagnosticDelivery(dir, journal, {
      endpoint: 'https://diagnostics.example',
      fetch: fetcher,
      now: () => now,
    }).initialize(false);
    await delivery.consent(true);
    journal.record('operation_result', { result: 'confirmed' });
    await journal.flush();
    await delivery.tick();
    expect(delivery.status()).toMatchObject({ acknowledged: 0, queuedBatches: 1 });
    mode = 'block';
    now += 86400_000;
    const sending = delivery.tick();
    await started;
    const revoke = delivery.consent(false);
    expect(delivery.status().consent).toBe(false);
    await revoke;
    await sending;
    expect(delivery.status()).toMatchObject({
      consent: false,
      queuedBatches: 0,
      deletionPending: 1,
      acknowledged: 0,
    });
    expect(uploads).toBe(2);
    await delivery.close();
    await journal.close();
  });
  it('recovers a saturated memory window from retained journal records without silently advancing past them', async () => {
    const dir = await directory();
    const journal = new SessionJournal(dir);
    const delivery = await new DiagnosticDelivery(dir, journal).initialize(false);
    await delivery.consent(true);
    // Block the actual outbox write while the independent journal continues,
    // so background threshold collection cannot drain away the saturation.
    let blocked = true;
    const originalOpen = filesystem.open;
    const intercept = vi.spyOn(filesystem, 'open').mockImplementation(async (...args) => {
      if (blocked && String(args[0]).endsWith('.gz'))
        throw Object.assign(new Error('synthetic outbox busy'), { code: 'EBUSY' });
      return originalOpen(...args);
    });
    for (let i = 0; i < 640; i++) {
      journal.record('load_fixture', { index: i, text: 'x'.repeat(4096) });
      if (i % 64 === 63) await journal.flush();
    }
    await journal.flush();
    blocked = false;
    await delivery.tick();
    const files = (await readdir(join(dir, 'diagnostic-outbox'))).filter((v) => v.endsWith('.gz'));
    const indices: number[] = [];
    for (const file of files) {
      const decoded = await decodeDiagnosticBatch(
        await readFile(join(dir, 'diagnostic-outbox', file)),
      );
      for (const event of decoded.events ?? []) {
        const item = event as { stage: string; evidence: { index?: number } };
        if (item.stage === 'load_fixture') indices.push(item.evidence.index!);
      }
    }
    expect(indices.sort((a, b) => a - b)).toEqual(Array.from({ length: 640 }, (_, i) => i));
    expect(delivery.status().omissionReasons).toHaveProperty(
      'memory_budget_recoverable_from_local_journal',
    );
    intercept.mockRestore();
    await delivery.close();
    await journal.close();
  });
  it('freezes a threshold collection before real disk IO while preserving later records for the next batch', async () => {
    const dir = await directory();
    const journal = new SessionJournal(dir);
    const delivery = await new DiagnosticDelivery(dir, journal).initialize(false);
    await delivery.consent(true);
    let release: () => void = () => {};
    let entered: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const originalOpen = filesystem.open;
    let blocked = true;
    const spy = vi.spyOn(filesystem, 'open').mockImplementation(async (...args) => {
      if (blocked && String(args[0]).endsWith('.gz')) {
        blocked = false;
        entered();
        await gate;
      }
      return originalOpen(...args);
    });
    try {
      for (let i = 0; i < 64; i++) {
        journal.record('collection_prefix', { index: i, text: 'x'.repeat(24576) });
        if (i % 8 === 7) await journal.flush();
      }
      await started;
      for (let i = 0; i < 10; i++) journal.record('collection_later', { index: i });
      await journal.flush();
      release();
      // The pause transaction joins the in-progress threshold collection without
      // forcing a second collection or using a timing/retry assertion.
      await delivery.pause(true);
      expect(delivery.status().queuedBatches).toBe(1);
      expect(delivery.status().pendingBytes).toBeGreaterThan(0);
      const first = (await readdir(join(dir, 'diagnostic-outbox'))).find((v) => v.endsWith('.gz'))!;
      const initial = await decodeDiagnosticBatch(
        await readFile(join(dir, 'diagnostic-outbox', first)),
      );
      expect(
        initial.events?.some((value) => (value as { stage: string }).stage === 'collection_later'),
      ).toBe(false);
      await delivery.tick();
      const indices: number[] = [];
      let prefix = 0;
      for (const file of (await readdir(join(dir, 'diagnostic-outbox'))).filter((v) =>
        v.endsWith('.gz'),
      )) {
        const decoded = await decodeDiagnosticBatch(
          await readFile(join(dir, 'diagnostic-outbox', file)),
        );
        for (const value of decoded.events ?? []) {
          const item = value as { stage: string; evidence: { index: number } };
          if (item.stage === 'collection_later') indices.push(item.evidence.index);
          if (item.stage === 'collection_prefix') prefix++;
        }
      }
      expect(prefix).toBe(64);
      expect(indices.sort((a, b) => a - b)).toEqual(Array.from({ length: 10 }, (_, i) => i));
      expect(delivery.status().omitted).toBe(0);
    } finally {
      release();
      spy.mockRestore();
      await delivery.close();
      await journal.close();
    }
  });
  it('collects normal operation batches every ten minutes while draining existing batches on the short poll', async () => {
    const dir = await directory();
    const journal = new SessionJournal(dir);
    const remote = service(() => now);
    remote.setState(join(dir, 'diagnostic-outbox', 'state.json'));
    let now = Date.now();
    const delivery = await new DiagnosticDelivery(dir, journal, {
      endpoint: 'https://diagnostics.example',
      fetch: remote.fetcher,
      now: () => now,
    }).initialize(false);
    try {
      await delivery.consent(true);
      for (let minute = 1; minute <= 20; minute++) {
        for (let operation = 0; operation < 300; operation++)
          journal.record('normal_operation', { minute, operation });
        await journal.flush();
        now += 60_000;
        await delivery.tick(false);
        expect(remote.batches.size).toBe(Math.floor(minute / 10));
      }
      const records = [];
      for (const batch of remote.batches.values())
        records.push(...((await decodeDiagnosticBatch(Buffer.from(batch))).events ?? []));
      expect(
        records.filter((value) => (value as { stage: string }).stage === 'normal_operation'),
      ).toHaveLength(6000);
      expect(delivery.status().omitted).toBe(0);
    } finally {
      await delivery.close();
      await journal.close();
    }
  });
  it.each(['permit', 'upload'])(
    'retains a server-expired body at %s across restart while continuing to send new evidence',
    async (expiryStage) => {
      const dir = await directory();
      let journal = new SessionJournal(dir);
      const remote = service();
      let expiredId: string | undefined;
      const fetcher: typeof fetch = async (input, init) => {
        const path = new URL(input instanceof Request ? input.url : input.toString()).pathname;
        if (expiryStage === 'upload' ? init?.method === 'PUT' : path.includes('/permits/')) {
          expiredId ??= path.split('/').at(-1)!;
          if (path.endsWith(expiredId))
            return Response.json({ error: 'batch_retention_expired' }, { status: 410 });
        }
        return remote.fetcher(input, init);
      };
      let delivery = await new DiagnosticDelivery(dir, journal, {
        endpoint: 'https://diagnostics.example',
        fetch: fetcher,
      }).initialize(false);
      try {
        await delivery.consent(true);
        journal.record('old_operation_failure', {
          error: new Error('original retained expired cause'),
        });
        await journal.flush();
        await delivery.tick();
        expect(delivery.status()).toMatchObject({
          acknowledged: 0,
          queuedBatches: 1,
          blockedBatches: 1,
        });
        await delivery.close();
        await journal.close();
        journal = new SessionJournal(dir);
        delivery = await new DiagnosticDelivery(dir, journal, {
          endpoint: 'https://diagnostics.example',
          fetch: fetcher,
        }).initialize(false);
        journal.record('new_operation', { result: 'confirmed' });
        await journal.flush();
        await delivery.tick();
        for (let poll = 0; poll < 6 && delivery.status().queuedBatches > 1; poll++)
          await delivery.tick();
        expect(delivery.status()).toMatchObject({ queuedBatches: 1, blockedBatches: 1 });
        expect(delivery.status().acknowledged).toBeGreaterThan(0);
        expect(
          JSON.stringify(
            await decodeDiagnosticBatch(
              await readFile(join(dir, 'diagnostic-outbox', `${expiredId}.gz`)),
            ),
          ),
        ).toContain('original retained expired cause');
        expect(
          JSON.stringify(
            await Promise.all(
              [...remote.batches.values()].map((value) =>
                decodeDiagnosticBatch(Buffer.from(value)),
              ),
            ),
          ),
        ).toContain('new_operation');
      } finally {
        await delivery.close();
        await journal.close();
      }
    },
  );
  it('collects a committed problem marker within fifteen seconds without forcing normal batches early', async () => {
    const dir = await directory();
    const journal = new SessionJournal(dir);
    const remote = service(() => now);
    let now = Date.now();
    const delivery = await new DiagnosticDelivery(dir, journal, {
      endpoint: 'https://diagnostics.example',
      fetch: remote.fetcher,
      now: () => now,
    }).initialize(false);
    try {
      await delivery.consent(true);
      await journal.recordCommitted('problem_report', { category: 'hud' });
      now += 14999;
      await delivery.tick(false);
      expect(remote.batches.size).toBe(0);
      now++;
      await delivery.tick(false);
      expect(remote.batches.size).toBe(1);
      expect(
        JSON.stringify(await decodeDiagnosticBatch(Buffer.from([...remote.batches.values()][0]!))),
      ).toContain('problem_report');
    } finally {
      await delivery.close();
      await journal.close();
    }
  });
  it.each([1, 2])(
    'requires fresh consent for finite retention and durably fences previous policy %s',
    async (policy) => {
      const dir = await directory();
      const journal = new SessionJournal(dir);
      const previous = await new DiagnosticDelivery(dir, journal).initialize(false);
      await previous.consent(true);
      journal.record('normal_operation', {
        result: 'full unacknowledged evidence before policy change',
      });
      await journal.flush();
      await previous.tick();
      await previous.close();
      await journal.close();
      const path = join(dir, 'diagnostic-outbox', 'state.json');
      const state = JSON.parse(await readFile(path, 'utf8')) as {
        consentPolicy: number;
        queue: { id: string }[];
        credentials: { installationId: string; token?: string; expiresAt?: number };
        nextAttemptAt: number;
        failures: number;
      };
      const oldInstallation = state.credentials.installationId;
      state.consentPolicy = policy;
      state.credentials.token = 'test-token';
      state.credentials.expiresAt = Date.now() + 86400_000;
      state.nextAttemptAt = Date.now() + 6 * 3600_000;
      state.failures = 12;
      await writeFile(path, JSON.stringify(state));
      let nextJournal = new SessionJournal(dir);
      const remote = service();
      remote.setState(path);
      let next = await new DiagnosticDelivery(dir, nextJournal, {
        endpoint: 'https://diagnostics.example.test',
        fetch: remote.fetcher,
      }).initialize(false);
      try {
        expect(next.status()).toMatchObject({
          consent: false,
          error: 'consent_policy_changed',
          queuedBatches: state.queue.length,
          blockedBatches: state.queue.length,
        });
        expect(
          (await readdir(join(dir, 'diagnostic-outbox'))).some((name) =>
            name.startsWith('consent-policy-revoked-'),
          ),
        ).toBe(true);
        const originalCopies = await Promise.all(
          state.queue.map((x) => readFile(join(dir, `diagnostic-outbox/${x.id}.gz`))),
        );
        expect(originalCopies.length).toBeGreaterThan(0);
        await next.close();
        await nextJournal.close();
        nextJournal = new SessionJournal(dir);
        next = await new DiagnosticDelivery(dir, nextJournal, {
          endpoint: 'https://diagnostics.example.test',
          fetch: remote.fetcher,
        }).initialize(false);
        const retained = await next.retainedBatches();
        for (let i = 0; i < state.queue.length; i++) {
          const copy = retained.find((x) => x.id === state.queue[i]!.id)!;
          expect(copy.gzip).toEqual(originalCopies[i]);
          expect(copy.automaticDelivery).toEqual({
            blocked: true,
            reason: 'consent_policy_changed',
          });
        }
        expect(JSON.stringify(await decodeDiagnosticBatch(retained[0]!.gzip!))).toContain(
          'full unacknowledged evidence before policy change',
        );
        await next.tick();
        expect(remote.calls).toEqual(['DELETE /v1/diagnostics/installation']);
        expect(remote.revoked()).toBe(true);
        await next.consent(true);
        const renewed = JSON.parse(await readFile(path, 'utf8')) as {
          consentPolicy: number;
          credentials: { installationId: string };
        };
        expect(renewed.consentPolicy).toBe(3);
        expect(renewed.credentials.installationId).not.toBe(oldInstallation);
        await nextJournal.flush();
        await next.tick();
        for (const item of state.queue) {
          expect(remote.batches.has(item.id)).toBe(false);
          expect(
            (await next.retainedBatches()).find((x) => x.id === item.id)?.automaticDelivery,
          ).toEqual({ blocked: true, reason: 'consent_policy_changed' });
        }
      } finally {
        await next.close();
        await nextJournal.close();
      }
    },
  );
  it('serializes rapid consent changes and coalesces durable revocation fences', async () => {
    const dir = await directory();
    const journal = new SessionJournal(dir);
    const delivery = await new DiagnosticDelivery(dir, journal).initialize(false);
    await Promise.all([delivery.consent(true), delivery.consent(false), delivery.consent(false)]);
    expect(delivery.status().consent).toBe(false);
    let disk = JSON.parse(
      await readFile(join(dir, 'diagnostic-outbox/state.json'), 'utf8'),
    ) as DiskState;
    expect(disk).toMatchObject({ consent: false, credentials: null });
    for (let i = 0; i < 70; i++) await delivery.consent(false);
    expect(
      (await readdir(join(dir, 'diagnostic-outbox'))).filter((n) => n.endsWith('.flag')),
    ).toHaveLength(1);
    await delivery.consent(true);
    disk = JSON.parse(
      await readFile(join(dir, 'diagnostic-outbox/state.json'), 'utf8'),
    ) as DiskState;
    expect(disk.consent).toBe(true);
    expect(disk.credentials.installationId).toBeTypeOf('string');
    expect(delivery.status().consent).toBe(true);
    expect(
      (await readdir(join(dir, 'diagnostic-outbox'))).filter((n) => n.endsWith('.flag')),
    ).toHaveLength(0);
    await delivery.close();
    await journal.close();
  });
  it('keeps an acknowledged batch durable when the receipt manifest commit fails', async () => {
    const dir = await directory();
    const journal = new SessionJournal(dir);
    const remote = service(() => now);
    let now = Date.now();
    const delivery = await new DiagnosticDelivery(dir, journal, {
      endpoint: 'https://diagnostics.example',
      fetch: remote.fetcher,
      now: () => now,
    }).initialize(false);
    await delivery.consent(true);
    journal.record('operation_result', { result: 'must-survive-receipt-commit-failure' });
    await journal.flush();
    const internal = delivery as unknown as {
      save(): Promise<void>;
      state: { acknowledged: number };
    };
    const save = internal.save.bind(delivery);
    let failed = false;
    const spy = vi.spyOn(internal, 'save').mockImplementation(async () => {
      if (internal.state.acknowledged && !failed) {
        failed = true;
        throw new Error('injected receipt manifest I/O failure');
      }
      await save();
    });
    await delivery.tick();
    expect(failed).toBe(true);
    expect(delivery.status()).toMatchObject({ acknowledged: 0, queuedBatches: 1 });
    const disk = JSON.parse(
      await readFile(join(dir, 'diagnostic-outbox/state.json'), 'utf8'),
    ) as DiskState;
    expect(disk.queue).toHaveLength(1);
    expect(disk.acknowledged).toBe(0);
    spy.mockRestore();
    await journal.flush();
    now += 86400_000;
    await delivery.tick();
    expect(remote.batches.size).toBe(1);
    expect(delivery.status()).toMatchObject({ acknowledged: 1, queuedBatches: 1 });
    await delivery.tick();
    expect(delivery.status()).toMatchObject({ acknowledged: 2, queuedBatches: 0 });
    const events = (
      await Promise.all(
        [...remote.batches.values()].map((value) => decodeDiagnosticBatch(Buffer.from(value))),
      )
    ).flatMap((value) => value.events ?? []);
    expect(
      events.filter((value) => (value as { stage: string }).stage === 'operation_result'),
    ).toHaveLength(1);
    expect(JSON.stringify(events)).toContain('injected receipt manifest I/O failure');
    await delivery.close();
    await journal.close();
  });
  it('does not resume old consent after a withdrawal manifest write fails and the process restarts', async () => {
    const dir = await directory();
    const journal = new SessionJournal(dir);
    const remote = service();
    const options = { endpoint: 'https://diagnostics.example', fetch: remote.fetcher };
    let delivery = await new DiagnosticDelivery(dir, journal, options).initialize(false);
    await delivery.consent(true);
    journal.record('operation_result', { result: 'enrolled-before-io-failure' });
    await journal.flush();
    await delivery.tick();
    const internal = delivery as unknown as { save(): Promise<void> };
    const spy = vi.spyOn(internal, 'save').mockRejectedValue(new Error('disk failure'));
    await expect(delivery.consent(false)).rejects.toThrow('disk failure');
    expect(delivery.status().consent).toBe(false);
    spy.mockRestore();
    await delivery.close();
    delivery = await new DiagnosticDelivery(dir, journal, options).initialize(false);
    expect(delivery.status()).toMatchObject({
      consent: false,
      queuedBatches: 0,
      deletionPending: 1,
    });
    const disk = JSON.parse(
      await readFile(join(dir, 'diagnostic-outbox/state.json'), 'utf8'),
    ) as DiskState;
    expect(disk).toMatchObject({ consent: false, credentials: null });
    await delivery.close();
    await journal.close();
  });
  it('withdraws during a blocked batch manifest commit without negative pending bytes or restart upload', async () => {
    const dir = await directory();
    const journal = new SessionJournal(dir);
    let delivery = await new DiagnosticDelivery(dir, journal).initialize(false);
    await delivery.consent(true);
    journal.record('operation_result', { result: 'concurrent-withdrawal' });
    await journal.flush();
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((r) => {
      entered = r;
    });
    const barrier = new Promise<void>((r) => {
      release = r;
    });
    const internal = delivery as unknown as { save(): Promise<void> };
    const save = internal.save.bind(delivery);
    const spy = vi.spyOn(internal, 'save').mockImplementationOnce(async () => {
      entered();
      await barrier;
      await save();
    });
    const ticking = delivery.tick();
    await started;
    const withdrawing = delivery.consent(false);
    expect(delivery.status().consent).toBe(false);
    release();
    await Promise.all([ticking, withdrawing]);
    spy.mockRestore();
    expect(delivery.status()).toMatchObject({ consent: false, pendingBytes: 0, queuedBatches: 0 });
    await delivery.close();
    delivery = await new DiagnosticDelivery(dir, journal).initialize(false);
    expect(delivery.status()).toMatchObject({ consent: false, queuedBatches: 0 });
    expect(
      (await readdir(join(dir, 'diagnostic-outbox'))).filter((n) => n.endsWith('.gz')),
    ).toEqual([]);
    await delivery.close();
    await journal.close();
  });
  it('retires completed source cursors instead of failing after 128 restarts', async () => {
    const dir = await directory();
    const journal = new SessionJournal(dir);
    let delivery = await new DiagnosticDelivery(dir, journal).initialize(false);
    await delivery.consent(true);
    await delivery.close();
    const path = join(dir, 'diagnostic-outbox/state.json');
    const disk = JSON.parse(await readFile(path, 'utf8')) as DiskState;
    disk.sessions = Object.fromEntries(
      Array.from({ length: 128 }, (_, i) => [
        `10000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
        { from: 0, queued: 0 },
      ]),
    );
    await writeFile(path, JSON.stringify(disk));
    delivery = await new DiagnosticDelivery(dir, journal).initialize(false);
    journal.record('operation_result', { result: 'after-128-restarts' });
    await journal.flush();
    await delivery.tick();
    expect(delivery.status().queuedBatches).toBeGreaterThan(0);
    const after = JSON.parse(await readFile(path, 'utf8')) as DiskState;
    expect(Object.keys(after.sessions)).toEqual([journal.sessionId]);
    await delivery.close();
    await journal.close();
  });
  it('bounds chunked enrollment receipts and rejects invalid durable credentials', async () => {
    const dir = await directory();
    const journal = new SessionJournal(dir);
    const delivery = await new DiagnosticDelivery(dir, journal, {
      endpoint: 'https://diagnostics.example',
      fetch: () =>
        Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new Uint8Array(8193));
                controller.close();
              },
            }),
          ),
        ),
    }).initialize(false);
    await delivery.consent(true);
    journal.record('operation_result', { result: 'retained-despite-hostile-response' });
    await journal.flush();
    await delivery.tick();
    expect(delivery.status()).toMatchObject({
      acknowledged: 0,
      queuedBatches: 1,
      error: 'receipt_size_budget',
    });
    await delivery.close();
    const path = join(dir, 'diagnostic-outbox/state.json');
    const disk = JSON.parse(await readFile(path, 'utf8')) as DiskState;
    disk.credentials.enrollmentSecret = 'invalid';
    await writeFile(path, JSON.stringify(disk));
    await expect(new DiagnosticDelivery(dir, journal).initialize(false)).rejects.toThrow();
    await journal.close();
  });
  it('withdraws while compressed batch fsync is blocked and never commits those bytes', async () => {
    const dir = await directory();
    const journal = new SessionJournal(dir);
    const delivery = await new DiagnosticDelivery(dir, journal).initialize(false);
    await delivery.consent(true);
    journal.record('operation_result', { result: 'withdraw-during-fsync' });
    await journal.flush();
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((r) => {
      entered = r;
    });
    const barrier = new Promise<void>((r) => {
      release = r;
    });
    const open = filesystem.open;
    vi.spyOn(filesystem, 'open').mockImplementation(async (...args) => {
      const file = await open(...args);
      if (String(args[0]).endsWith('.gz')) {
        const sync = file.sync.bind(file);
        vi.spyOn(file, 'sync').mockImplementationOnce(async () => {
          entered();
          await barrier;
          await sync();
        });
      }
      return file;
    });
    const ticking = delivery.tick();
    await started;
    const withdrawing = delivery.consent(false);
    release();
    await Promise.all([ticking, withdrawing]);
    expect(delivery.status()).toMatchObject({ consent: false, pendingBytes: 0, queuedBatches: 0 });
    expect(
      (await readdir(join(dir, 'diagnostic-outbox'))).filter((n) => n.endsWith('.gz')),
    ).toEqual([]);
    await delivery.close();
    await journal.close();
  });
  it('pauses transport across restart while continuing to retain local queued evidence', async () => {
    const dir = await directory();
    const journal = new SessionJournal(dir);
    const remote = service();
    let delivery = await new DiagnosticDelivery(dir, journal, {
      endpoint: 'https://diagnostics.example',
      fetch: remote.fetcher,
    }).initialize(false);
    await delivery.consent(true);
    await delivery.pause(true);
    journal.record('operation_result', { result: 'during-pause' });
    await journal.flush();
    await delivery.tick();
    expect(remote.calls).toEqual([]);
    expect(delivery.status()).toMatchObject({ consent: true, paused: true, queuedBatches: 1 });
    await delivery.close();
    delivery = await new DiagnosticDelivery(dir, journal, {
      endpoint: 'https://diagnostics.example',
      fetch: remote.fetcher,
    }).initialize(false);
    await delivery.tick();
    expect(remote.calls).toEqual([]);
    await delivery.pause(false);
    await delivery.tick();
    expect(remote.batches.size).toBeGreaterThan(0);
    await delivery.close();
    await journal.close();
  });
  it('does not cancel a concurrent consent request when pausing transport', async () => {
    const dir = await directory();
    const journal = new SessionJournal(dir);
    const remote = service();
    const delivery = await new DiagnosticDelivery(dir, journal, {
      endpoint: 'https://diagnostics.example',
      fetch: remote.fetcher,
    }).initialize(false);
    await Promise.all([delivery.consent(true), delivery.pause(true)]);
    journal.record('operation_result', { result: 'retained-with-consent-and-pause' });
    await journal.flush();
    await delivery.tick();
    expect(delivery.status()).toMatchObject({ consent: true, paused: true, queuedBatches: 1 });
    expect(remote.calls).toEqual([]);
    await delivery.close();
    await journal.close();
  });
  it('keeps transport paused when resuming cannot be saved and does not let an older failure override a newer pause', async () => {
    const dir = await directory();
    const journal = new SessionJournal(dir);
    const remote = service();
    const delivery = await new DiagnosticDelivery(dir, journal, {
      endpoint: 'https://diagnostics.example',
      fetch: remote.fetcher,
    }).initialize(false);
    await delivery.consent(true);
    await delivery.pause(true);
    journal.record('operation_result', { result: 'keep-paused-after-resume-failure' });
    await journal.flush();
    const internal = delivery as unknown as { save(): Promise<void> };
    const save = internal.save.bind(delivery);
    const spy = vi.spyOn(internal, 'save').mockRejectedValueOnce(new Error('resume write failed'));
    await expect(delivery.pause(false)).rejects.toThrow('resume write failed');
    expect(delivery.status().paused).toBe(true);
    await delivery.tick();
    expect(remote.calls).toEqual([]);
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((r) => {
      entered = r;
    });
    const barrier = new Promise<void>((r) => {
      release = r;
    });
    spy
      .mockImplementationOnce(async () => {
        entered();
        await barrier;
        throw new Error('older resume failed');
      })
      .mockImplementation(save);
    const resume = delivery.pause(false);
    const failed = expect(resume).rejects.toThrow('older resume failed');
    await started;
    const pause = delivery.pause(true);
    release();
    await failed;
    await pause;
    expect(delivery.status().paused).toBe(true);
    const disk = JSON.parse(await readFile(join(dir, 'diagnostic-outbox/state.json'), 'utf8')) as {
      paused: boolean;
    };
    expect(disk.paused).toBe(true);
    await delivery.close();
    await journal.close();
  });
});
