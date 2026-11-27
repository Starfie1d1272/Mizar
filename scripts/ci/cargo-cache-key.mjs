import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const hash = (value) => createHash('sha256').update(value).digest('hex');

function normalizeTomlSectionVersion(manifest, sectionHeader) {
  const escaped = sectionHeader.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const header = new RegExp(`^\\[${escaped}\\]\\r?$`, 'm').exec(manifest);
  if (!header) throw new Error(`Cargo.toml has no [${sectionHeader}] section`);
  const sectionStart = manifest.indexOf('\n', header.index) + 1;
  const nextSection = /^\[[^\r\n]+\]\r?$/gm;
  nextSection.lastIndex = sectionStart;
  const sectionEnd = nextSection.exec(manifest)?.index ?? manifest.length;
  const packageText = manifest.slice(sectionStart, sectionEnd);
  const ownVersion = /^(version[ \t]*=[ \t]*)"[^"\r\n]+"(?=[ \t]*(?:#[^\r\n]*)?\r?$)/gm;
  if ([...packageText.matchAll(ownVersion)].length !== 1) {
    throw new Error(`Cargo.toml [${sectionHeader}] must contain exactly one version`);
  }
  return (
    manifest.slice(0, sectionStart) +
    packageText.replace(ownVersion, '$1"0.0.0"') +
    manifest.slice(sectionEnd)
  );
}

function normalizeLockPackageVersions(lock, packageNames) {
  let normalized = lock;
  for (const name of packageNames) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const ownLockVersion = new RegExp(
      `(^\\[\\[package\\]\\]\\r?\\nname[ \t]*=[ \t]*"${escaped}"\\r?\\nversion[ \t]*=[ \t]*)"[^"\r\n]+"`,
      'gm',
    );
    if ([...normalized.matchAll(ownLockVersion)].length !== 1) {
      throw new Error(`Cargo.lock must contain exactly one ${name} package`);
    }
    normalized = normalized.replace(ownLockVersion, '$1"0.0.0"');
  }
  return normalized.replace(/\r\n/g, '\n');
}

// Only Mizar's own package versions are excluded. Dependency versions and Cargo profiles
// remain part of the cache identity; Cargo independently fingerprints source.
export function cargoCacheFingerprints(hostManifest, hostLock, installerLock) {
  const normalizedHostManifest = normalizeTomlSectionVersion(hostManifest, 'package').replace(
    /\r\n/g,
    '\n',
  );
  const normalizedHostLock = normalizeLockPackageVersions(hostLock, ['mizar-desktop']);
  const normalizedInstallerLock = normalizeLockPackageVersions(installerLock, [
    'mizar-common',
    'mizar-launcher',
    'mizar-applier',
  ]);
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
