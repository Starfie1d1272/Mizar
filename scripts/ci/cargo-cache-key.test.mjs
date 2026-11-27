import test from 'node:test';
import assert from 'node:assert/strict';
import { cargoCacheFingerprints } from './cargo-cache-key.mjs';

const hostManifest = (version, dep = '1.0.229') =>
  `[package]\nname = "mizar-desktop"\nversion = "${version}"\n\n[dependencies]\nserde = "${dep}"\n`;

const hostLock = (version, dep = '1.0.229') =>
  `[[package]]\nname = "mizar-desktop"\nversion = "${version}"\n\n[[package]]\nname = "serde"\nversion = "${dep}"\n`;

const installerLock = (version, dep = '1.0.229') =>
  `[[package]]\nname = "mizar-applier"\nversion = "${version}"\n\n[[package]]\nname = "mizar-common"\nversion = "${version}"\n\n[[package]]\nname = "mizar-launcher"\nversion = "${version}"\n\n[[package]]\nname = "serde"\nversion = "${dep}"\n`;

test('cargoCacheFingerprints ignores Mizar own package versions', () => {
  const a = cargoCacheFingerprints(
    hostManifest('1.13.5'),
    hostLock('1.13.5'),
    installerLock('1.13.5'),
  );
  const b = cargoCacheFingerprints(
    hostManifest('1.14.0-rc.1'),
    hostLock('1.14.0-rc.1'),
    installerLock('1.14.0-rc.1'),
  );
  assert.deepEqual(a, b);
});

test('installer dependency change invalidates registry_lock without invalidating host_lock or host_manifest', () => {
  const a = cargoCacheFingerprints(
    hostManifest('1.13.5'),
    hostLock('1.13.5'),
    installerLock('1.13.5', '1.0.229'),
  );
  const b = cargoCacheFingerprints(
    hostManifest('1.13.5'),
    hostLock('1.13.5'),
    installerLock('1.13.5', '1.0.230'),
  );
  assert.notEqual(a.registry_lock, b.registry_lock);
  assert.equal(a.host_lock, b.host_lock);
  assert.equal(a.host_manifest, b.host_manifest);
});
