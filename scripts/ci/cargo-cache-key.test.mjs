import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { cargoCacheFingerprints } from './cargo-cache-key.mjs';

const manifest = readFileSync('apps/desktop/src-tauri/Cargo.toml', 'utf8');
const lock = readFileSync('apps/desktop/src-tauri/Cargo.lock', 'utf8');

describe('Cargo cache identity', () => {
  it('reuses dependency and profile keys across RC version bumps', () => {
    const bumpedManifest = manifest.replace(
      /^(version[ \t]*=[ \t]*)"[^"\r\n]+"/m,
      '$1"9.9.9-rc.99"',
    );
    const bumpedLock = lock.replace(
      /(^\[\[package\]\]\r?\nname = "mizar-desktop"\r?\nversion = )"[^"\r\n]+"/m,
      '$1"9.9.9-rc.99"',
    );
    expect(bumpedManifest).not.toBe(manifest);
    expect(bumpedLock).not.toBe(lock);
    expect(cargoCacheFingerprints(bumpedManifest, bumpedLock)).toEqual(
      cargoCacheFingerprints(manifest, lock),
    );
  });

  it('normalizes CRLF checkout line endings without changing cache identity', () => {
    const windowsManifest = manifest.replace(/\r?\n/g, '\r\n');
    const windowsLock = lock.replace(/\r?\n/g, '\r\n');
    expect(cargoCacheFingerprints(windowsManifest, windowsLock)).toEqual(
      cargoCacheFingerprints(manifest, lock),
    );
  });

  it('invalidates relevant keys when dependencies or compiler profile change', () => {
    const original = cargoCacheFingerprints(manifest, lock);
    const changedLock = lock.replace(
      /(^\[\[package\]\]\r?\nname = "adler2"\r?\nversion = )"[^"\r\n]+"/m,
      '$1"9.9.9"',
    );
    const changedProfile = manifest.replace('lto = "thin"', 'lto = true');
    expect(changedLock).not.toBe(lock);
    expect(changedProfile).not.toBe(manifest);
    const changedCodegen = manifest.replace('codegen-units = 16', 'codegen-units = 1');
    expect(changedCodegen).not.toBe(manifest);
    expect(cargoCacheFingerprints(changedCodegen, lock).manifest).not.toBe(original.manifest);
    expect(cargoCacheFingerprints(manifest, changedLock).lock).not.toBe(original.lock);
    expect(cargoCacheFingerprints(changedProfile, lock).manifest).not.toBe(original.manifest);
  });

  it('keeps the production compiler profile distinct from the fast CI profile', () => {
    const release = manifest.split('[profile.release]')[1].split('[profile.ci]')[0];
    expect(release).toMatch(/^strip = true$/m);
    expect(release).toMatch(/^lto = "thin"$/m);
    expect(release).toMatch(/^codegen-units = 16$/m);
    const ci = manifest.split('[profile.ci]')[1];
    expect(ci).toMatch(/^lto = false$/m);
    expect(ci).toMatch(/^opt-level = 0$/m);
  });

  it('fails closed when the local package version cannot be identified', () => {
    expect(() => cargoCacheFingerprints(manifest.replace('[package]', '[unknown]'), lock)).toThrow(
      '[package]',
    );
    expect(() =>
      cargoCacheFingerprints(manifest, lock.replace('name = "mizar-desktop"', 'name = "removed"')),
    ).toThrow('mizar-desktop');
  });
});
