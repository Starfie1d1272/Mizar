import { Buffer } from 'node:buffer';
import { RESOURCE_ASSET_NAMES } from './catalog.mjs';
import { requireValue } from './index.mjs';
export const MACHINE_METADATA_NAME = 'machine-metadata.json';
export const MACHINE_METADATA_MAX_BYTES = 16 * 1024 * 1024;
const names = new Set([
  ...Object.values(RESOURCE_ASSET_NAMES),
  'release-manifest.json',
  'distribution-manifest.json',
  'core-release-manifest.json',
  'core-distribution-manifest.json',
  'NSIS-LICENSE.txt',
  'qualification-provenance.json',
  'update-index.json',
]);
const limit = (name) =>
  name.includes('provenance') || name === 'update-index.json' ? 2 * 1024 * 1024 : 64 * 1024;
/** A bounded byte carrier only. Every extracted claim still needs its original SDK verifier. */
export function makeMachineMetadata(files) {
  const entries = [...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  requireValue(
    entries.length > 0 &&
      entries.length <= names.size &&
      new Set(entries.map(([name]) => name)).size === entries.length,
    'Invalid machine metadata entries',
  );
  const encoded = entries.map(([name, bytes]) => {
    requireValue(
      names.has(name) && Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= limit(name),
      'Invalid machine metadata name or size',
    );
    return { name, bytesBase64: bytes.toString('base64') };
  });
  const bytes = Buffer.from(
    JSON.stringify({ schemaVersion: 'mizar.machine-metadata.v1', files: encoded }) + '\n',
  );
  requireValue(bytes.length <= MACHINE_METADATA_MAX_BYTES, 'Machine metadata exceeds limit');
  return bytes;
}
export function readMachineMetadata(bytes) {
  requireValue(
    Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= MACHINE_METADATA_MAX_BYTES,
    'Machine metadata exceeds limit',
  );
  const carrier = JSON.parse(bytes.toString('utf8'));
  requireValue(
    carrier &&
      Object.keys(carrier).sort().join(',') === 'files,schemaVersion' &&
      carrier.schemaVersion === 'mizar.machine-metadata.v1' &&
      Array.isArray(carrier.files) &&
      carrier.files.length > 0 &&
      carrier.files.length <= names.size,
    'Invalid machine metadata structure',
  );
  const result = new Map();
  for (const entry of carrier.files) {
    requireValue(
      entry &&
        Object.keys(entry).sort().join(',') === 'bytesBase64,name' &&
        names.has(entry.name) &&
        !result.has(entry.name) &&
        typeof entry.bytesBase64 === 'string' &&
        entry.bytesBase64.length <= Math.ceil(limit(entry.name) / 3) * 4,
      'Invalid or duplicate machine metadata entry',
    );
    const original = Buffer.from(entry.bytesBase64, 'base64');
    requireValue(
      original.length > 0 &&
        original.length <= limit(entry.name) &&
        original.toString('base64') === entry.bytesBase64,
      'Invalid machine metadata encoding',
    );
    result.set(entry.name, original);
  }
  // Reject duplicate JSON keys, reordering, invalid UTF-8 and trailing content.
  requireValue(makeMachineMetadata(result).equals(bytes), 'Noncanonical machine metadata');
  return result;
}
export function readMachineFile(bytes, name) {
  const original = readMachineMetadata(bytes).get(name);
  requireValue(original, 'Required original machine metadata is missing');
  return original;
}
