import type { Buffer } from 'node:buffer';
import type { Bundle, BundleVerifier } from 'sigstore';
export type MizarSignerRole = 'qualification' | 'promotion';
export function signerIdentity(workflow: MizarSignerRole): string;
export function createMizarVerifier(
  workflow: MizarSignerRole,
  sourceSha: string,
  tufCachePath?: string,
): Promise<BundleVerifier>;
export function verifyMizarAttestation(
  bytes: Buffer,
  name: string,
  bundle: Bundle,
  verifier: BundleVerifier,
  workflow?: MizarSignerRole,
): string;

export function mizarCertificatePolicy(
  workflow: MizarSignerRole,
  sourceSha: string,
): {
  certificateIssuer: string;
  certificateIdentityURI: string;
  certificateOIDs: Record<string, string>;
};
