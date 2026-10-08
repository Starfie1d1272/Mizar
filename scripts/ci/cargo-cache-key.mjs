import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const hash = (value) => createHash('sha256').update(value).digest('hex');

// Only Mizar's own version is excluded. Dependency versions and Cargo profiles
// remain part of the cache identity; Cargo independently fingerprints source.
export function cargoCacheFingerprints(manifest, lock) {
  const header = /^\[package\]\r?$/m.exec(manifest);
  if (!header) throw new Error('Cargo.toml has no [package] section');
  const sectionStart = manifest.indexOf('\n', header.index) + 1;
  const nextSection = /^\[[^\r\n]+\]\r?$/gm;
  nextSection.lastIndex = sectionStart;
  const sectionEnd = nextSection.exec(manifest)?.index ?? manifest.length;
  const packageText = manifest.slice(sectionStart, sectionEnd);
  const ownVersion = /^(version[ \t]*=[ \t]*)"[^"\r\n]+"(?=[ \t]*(?:#[^\r\n]*)?$)/gm;
  if ([...packageText.matchAll(ownVersion)].length !== 1) {
    throw new Error('Cargo.toml must contain exactly one package.version');
  }
  const normalizedManifest =
    manifest.slice(0, sectionStart) +
    packageText.replace(ownVersion, '$1"0.0.0"') +
    manifest.slice(sectionEnd);

  const ownLockVersion =
    /(^\[\[package\]\]\r?\nname[ \t]*=[ \t]*"mizar-desktop"\r?\nversion[ \t]*=[ \t]*)"[^"\r\n]+"/gm;
  if ([...lock.matchAll(ownLockVersion)].length !== 1) {
    throw new Error('Cargo.lock must contain exactly one mizar-desktop package');
  }
  const normalizedLock = lock.replace(ownLockVersion, '$1"0.0.0"');
  return { manifest: hash(normalizedManifest), lock: hash(normalizedLock) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const fingerprints = cargoCacheFingerprints(
    readFileSync('apps/desktop/src-tauri/Cargo.toml', 'utf8'),
    readFileSync('apps/desktop/src-tauri/Cargo.lock', 'utf8'),
  );
  if (!process.env.GITHUB_OUTPUT) throw new Error('GITHUB_OUTPUT is required');
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    'manifest=' + fingerprints.manifest + '\nlock=' + fingerprints.lock + '\n',
  );
  console.log('Cargo cache keys exclude only the application version');
}
