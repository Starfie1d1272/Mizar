import { DIAGNOSTIC_CONSENT_REVISION } from './version.js';
/** Public integrity certificate, never a bearer credential. The independent
 * authenticated upload must carry these same bytes on every retry. */
export interface DiagnosticUploadPermit {
  schema: 'mizar-diagnostic-permit/2';
  installationId: string;
  installationCreatedAt: number;
  consentRevision: typeof DIAGNOSTIC_CONSENT_REVISION;
  payloadSha256: string;
  payloadCreatedAt: number;
  issuedAt: number;
  expiresAt: number;
  signature: string;
}
export const DIAGNOSTIC_PERMIT_BYTES = 1024;
export const DIAGNOSTIC_BODY_LIFETIME_MS = 7 * 86400_000;
export const DIAGNOSTIC_AUTOMATIC_LIFETIME_MS = 90 * 86400_000;
export const DIAGNOSTIC_CLOCK_SKEW_MS = 5 * 60_000;
/** RFC 9562 UUIDv7: creation time cannot be changed without changing identity.
 * Random bytes come from the caller's cryptographic generator; no host/MAC ID. */
export function diagnosticInstallationId(now: number, entropy: Uint8Array): string {
  if (!Number.isSafeInteger(now) || now < 0 || now > 0xffffffffffff || entropy.length !== 16)
    throw new Error('invalid_diagnostic_installation_time');
  const bytes = Uint8Array.from(entropy);
  let time = now;
  for (let index = 5; index >= 0; index--) {
    bytes[index] = time % 256;
    time = Math.floor(time / 256);
  }
  bytes[6] = (bytes[6]! & 15) | 0x70;
  bytes[8] = (bytes[8]! & 63) | 0x80;
  const text = [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
  return `${text.slice(0, 8)}-${text.slice(8, 12)}-${text.slice(12, 16)}-${text.slice(16, 20)}-${text.slice(20)}`;
}
export function diagnosticInstallationCreatedAt(id: string): number | null {
  return /^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id)
    ? parseInt(id.replaceAll('-', '').slice(0, 12), 16)
    : null;
}
/** RFC 1952 MTIME is covered by the immutable original gzip SHA. Set once only. */
export function diagnosticGzipCreatedAt(bytes: Uint8Array): number | null {
  if (
    bytes.length < 18 ||
    bytes[0] !== 31 ||
    bytes[1] !== 139 ||
    bytes[2] !== 8 ||
    ![0, 4].includes(bytes[3]!)
  )
    return null;
  const seconds = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4, true);
  return seconds ? seconds * 1000 : null;
}
export function stampDiagnosticGzip(bytes: Uint8Array, now: number): Uint8Array {
  if (
    bytes.length < 18 ||
    bytes[0] !== 31 ||
    bytes[1] !== 139 ||
    bytes[2] !== 8 ||
    bytes[3] !== 0 ||
    !Number.isSafeInteger(now) ||
    now < 1000 ||
    now > 0xffffffff * 1000 ||
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4, true) !== 0
  )
    throw new Error('diagnostic_creation_time_cannot_be_rewritten');
  const result = Uint8Array.from(bytes);
  new DataView(result.buffer).setUint32(4, Math.floor(now / 1000), true);
  return result;
}
export function diagnosticAutomaticTimeReason(
  createdAt: number | null,
  now: number,
): string | null {
  if (createdAt === null || !Number.isSafeInteger(createdAt) || createdAt <= 0)
    return 'payload_creation_time_missing';
  if (createdAt > now + DIAGNOSTIC_CLOCK_SKEW_MS) return 'payload_clock_future';
  if (createdAt + DIAGNOSTIC_AUTOMATIC_LIFETIME_MS <= now) return 'automatic_window_expired';
  return null;
}
export function diagnosticPermit(value: unknown): DiagnosticUploadPermit | null {
  if (!value || typeof value !== 'object') return null;
  const p = value as DiagnosticUploadPermit;
  return p.schema === 'mizar-diagnostic-permit/2' &&
    typeof p.installationId === 'string' &&
    /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(p.installationId) &&
    typeof p.payloadSha256 === 'string' &&
    /^[a-f0-9]{64}$/.test(p.payloadSha256) &&
    Number.isSafeInteger(p.installationCreatedAt) &&
    p.installationCreatedAt >= 0 &&
    p.installationCreatedAt <= p.issuedAt &&
    p.consentRevision === DIAGNOSTIC_CONSENT_REVISION &&
    Number.isSafeInteger(p.issuedAt) &&
    p.issuedAt >= 0 &&
    Number.isSafeInteger(p.payloadCreatedAt) &&
    p.payloadCreatedAt > 0 &&
    p.payloadCreatedAt <= p.issuedAt + DIAGNOSTIC_CLOCK_SKEW_MS &&
    p.expiresAt ===
      Math.min(
        p.issuedAt + DIAGNOSTIC_BODY_LIFETIME_MS,
        p.payloadCreatedAt + DIAGNOSTIC_AUTOMATIC_LIFETIME_MS,
      ) &&
    p.expiresAt > p.issuedAt &&
    typeof p.signature === 'string' &&
    /^[A-Za-z0-9_-]{43}$/.test(p.signature) &&
    Object.keys(p).length === 9
    ? p
    : null;
}
export const diagnosticPermitClaims = (p: Omit<DiagnosticUploadPermit, 'signature'>) =>
  `mizar-diagnostic-permit-v2|${p.installationId}|${p.installationCreatedAt}|${p.consentRevision}|${p.payloadSha256}|${p.payloadCreatedAt}|${p.issuedAt}|${p.expiresAt}`;
/** RFC 1952 FEXTRA, one MZ subfield. Gzip readers still decode the complete body. */
export function sealDiagnosticGzip(bytes: Uint8Array, permit: DiagnosticUploadPermit) {
  if (
    !diagnosticPermit(permit) ||
    diagnosticGzipCreatedAt(bytes) !== permit.payloadCreatedAt ||
    bytes.length < 18 ||
    bytes[0] !== 31 ||
    bytes[1] !== 139 ||
    bytes[2] !== 8 ||
    bytes[3] !== 0
  )
    throw new Error('invalid_diagnostic_permit');
  const certificate = new TextEncoder().encode(JSON.stringify(permit));
  if (certificate.length + 6 > DIAGNOSTIC_PERMIT_BYTES) throw new Error('permit_budget');
  const result = new Uint8Array(bytes.length + certificate.length + 6);
  result.set(bytes.subarray(0, 10));
  result[3] = 4;
  const view = new DataView(result.buffer);
  view.setUint16(10, certificate.length + 4, true);
  result[12] = 77;
  result[13] = 90;
  view.setUint16(14, certificate.length, true);
  result.set(certificate, 16);
  result.set(bytes.subarray(10), 16 + certificate.length);
  return result;
}
export function readDiagnosticGzipPermit(bytes: Uint8Array) {
  if (
    bytes.length < 24 ||
    bytes[0] !== 31 ||
    bytes[1] !== 139 ||
    bytes[2] !== 8 ||
    bytes[3] !== 4 ||
    bytes[12] !== 77 ||
    bytes[13] !== 90
  )
    return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const extra = view.getUint16(10, true);
  const length = view.getUint16(14, true);
  if (extra !== length + 4 || extra + 2 > DIAGNOSTIC_PERMIT_BYTES || 12 + extra + 8 > bytes.length)
    return null;
  let permit: DiagnosticUploadPermit | null;
  try {
    permit = diagnosticPermit(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(16, 16 + length))),
    );
  } catch {
    return null;
  }
  if (!permit) return null;
  const payload = new Uint8Array(bytes.length - extra - 2);
  payload.set(bytes.subarray(0, 10));
  payload[3] = 0;
  payload.set(bytes.subarray(12 + extra), 10);
  return diagnosticGzipCreatedAt(payload) === permit.payloadCreatedAt ? { permit, payload } : null;
}
