import { DIAGNOSTIC_CONSENT_REVISION } from './version.js';
/** Public integrity certificate, never a bearer credential. The independent
 * authenticated upload must carry these same bytes on every retry. */
export interface DiagnosticUploadPermit {
  schema: 'mizar-diagnostic-permit/1';
  installationId: string;
  installationCreatedAt: number;
  consentRevision: typeof DIAGNOSTIC_CONSENT_REVISION;
  payloadSha256: string;
  issuedAt: number;
  expiresAt: number;
  signature: string;
}
export const DIAGNOSTIC_PERMIT_BYTES = 1024;
export const DIAGNOSTIC_BODY_LIFETIME_MS = 7 * 86400_000;
export function diagnosticPermit(value: unknown): DiagnosticUploadPermit | null {
  if (!value || typeof value !== 'object') return null;
  const p = value as DiagnosticUploadPermit;
  return p.schema === 'mizar-diagnostic-permit/1' &&
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
    p.expiresAt === p.issuedAt + DIAGNOSTIC_BODY_LIFETIME_MS &&
    typeof p.signature === 'string' &&
    /^[A-Za-z0-9_-]{43}$/.test(p.signature) &&
    Object.keys(p).length === 8
    ? p
    : null;
}
export const diagnosticPermitClaims = (p: Omit<DiagnosticUploadPermit, 'signature'>) =>
  `mizar-diagnostic-permit-v1|${p.installationId}|${p.installationCreatedAt}|${p.consentRevision}|${p.payloadSha256}|${p.issuedAt}|${p.expiresAt}`;
/** RFC 1952 FEXTRA, one MZ subfield. Gzip readers still decode the complete body. */
export function sealDiagnosticGzip(bytes: Uint8Array, permit: DiagnosticUploadPermit) {
  if (
    !diagnosticPermit(permit) ||
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
  return { permit, payload };
}
