import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  HOST_CARGO_PACKAGES,
  INSTALLER_CARGO_PACKAGES,
  replaceLockPackageVersions,
  replaceTomlSectionVersion,
} from '../qualification/app-version.mjs';

const hash = (value) => createHash('sha256').update(value).digest('hex');

// Only Mizar's own package versions are excluded. Dependency versions and Cargo profiles
// remain part of the cache identity; Cargo independently fingerprints source.
export function cargoCacheFingerprints(hostManifest, hostLock, installerLock) {
  const normalizedHostManifest = replaceTomlSectionVersion(
    hostManifest,
    'package',
    '0.0.0',
  ).replace(/\r\n/g, '\n');
  const normalizedHostLock = replaceLockPackageVersions(
    hostLock,
    HOST_CARGO_PACKAGES,
    '0.0.0',
  ).replace(/\r\n/g, '\n');
  const normalizedInstallerLock = replaceLockPackageVersions(
    installerLock,
    INSTALLER_CARGO_PACKAGES,
    '0.0.0',
  ).replace(/\r\n/g, '\n');
  return {
    registry_lock: hash(`${normalizedHostLock}\n${normalizedInstallerLock}`),
    host_lock: hash(normalizedHostLock),
    host_manifest: hash(normalizedHostManifest),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const fingerprints = cargoCacheFingerprints(
    readFileSync('apps/desktop/src-tauri/Cargo.toml', 'utf8'),
    readFileSync('apps/desktop/src-tauri/Cargo.lock', 'utf8'),
    readFileSync('apps/desktop/installer/Cargo.lock', 'utf8'),
  );
  if (!process.env.GITHUB_OUTPUT) throw new Error('GITHUB_OUTPUT is required');
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `registry_lock=${fingerprints.registry_lock}\nhost_lock=${fingerprints.host_lock}\nhost_manifest=${fingerprints.host_manifest}\n`,
  );
  console.log('Cargo cache keys exclude only Mizar package versions');
}
