import { randomBytes, createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { expect, it } from 'vitest';
import {
  diagnosticInstallationId,
  diagnosticInstallationCreatedAt,
  diagnosticGzipCreatedAt,
  stampDiagnosticGzip,
  diagnosticAutomaticTimeReason,
  DIAGNOSTIC_AUTOMATIC_LIFETIME_MS,
  sealDiagnosticGzip,
  readDiagnosticGzipPermit,
  type DiagnosticUploadPermit,
} from '../src/diagnostics-upload.js';

it('binds the finite enrollment lifetime to the UUIDv7 identity, without a host identifier', () => {
  const now = 0x017f22e279b0; // RFC 9562 UUIDv7 example timestamp.
  const id = diagnosticInstallationId(now, randomBytes(16));
  expect(id.slice(0, 14)).toBe('017f22e2-79b0-');
  expect(diagnosticInstallationCreatedAt(id)).toBe(now);
  expect(diagnosticInstallationId(now, randomBytes(16))).not.toBe(id);
  expect(diagnosticInstallationCreatedAt(id.slice(0, 14) + '4' + id.slice(15))).toBeNull();
});
it('keeps original gzip time and SHA stable through certificate roundtrip, and refuses renewing an old raw payload', () => {
  const now = 1_800_000_000_000;
  const text = 'complete original operation\nouter error\ncaused by ENOSPC';
  const raw = stampDiagnosticGzip(gzipSync(text), now);
  const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
  const permit: DiagnosticUploadPermit = {
    schema: 'mizar-diagnostic-permit/2',
    installationId: diagnosticInstallationId(now, randomBytes(16)),
    installationCreatedAt: now,
    consentRevision: 'technical-diagnostics-v3',
    payloadSha256: sha(raw),
    payloadCreatedAt: now,
    issuedAt: now,
    expiresAt: now + 7 * 86400_000,
    signature: 'a'.repeat(43),
  };
  const wire = sealDiagnosticGzip(raw, permit);
  expect(gunzipSync(wire).toString()).toBe(text);
  expect(readDiagnosticGzipPermit(wire)!.payload).toEqual(raw);
  expect(sha(readDiagnosticGzipPermit(wire)!.payload)).toBe(permit.payloadSha256);
  expect(diagnosticGzipCreatedAt(wire)).toBe(now);
  expect(() => stampDiagnosticGzip(raw, now + 86400_000)).toThrow('cannot_be_rewritten');
  expect(() => sealDiagnosticGzip(raw, { ...permit, payloadCreatedAt: now + 1000 })).toThrow(
    'invalid_diagnostic_permit',
  );
  expect(diagnosticAutomaticTimeReason(now, now + DIAGNOSTIC_AUTOMATIC_LIFETIME_MS - 1)).toBeNull();
  expect(diagnosticAutomaticTimeReason(now, now + DIAGNOSTIC_AUTOMATIC_LIFETIME_MS)).toBe(
    'automatic_window_expired',
  );
  expect(diagnosticAutomaticTimeReason(now + 300_001, now)).toBe('payload_clock_future');
  expect(diagnosticAutomaticTimeReason(diagnosticGzipCreatedAt(gzipSync(text)), now)).toBe(
    'payload_creation_time_missing',
  );
});
