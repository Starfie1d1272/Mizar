import { readFile } from 'node:fs/promises';
import { fileURLToPath, URL } from 'node:url';

// Cargo is authoritative; the Tauri mirror is required to agree before a build.
export async function readAppVersion(root = new URL('../../', import.meta.url)) {
  const cargo = await readFile(new URL('apps/desktop/src-tauri/Cargo.toml', root), 'utf8');
  const appVersion = cargo.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
  const config = JSON.parse(
    await readFile(new URL('apps/desktop/src-tauri/tauri.conf.json', root), 'utf8'),
  );
  if (!appVersion || config.version !== appVersion) throw new Error('Cargo / Tauri 应用版本不一致');
  return appVersion;
}
export function validateReleaseTag(tag, appVersion) {
  if (!/^v\d+\.\d+\.\d+(?:-rc\.\d+)?$/.test(tag) || tag !== `v${appVersion}`)
    throw new Error('发布标签与应用版本不一致');
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const version = await readAppVersion();
  if (process.argv[2]) validateReleaseTag(process.argv[2], version);
  console.log(version);
}
