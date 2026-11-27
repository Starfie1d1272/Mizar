import { readFile } from 'node:fs/promises';
import { fileURLToPath, URL } from 'node:url';

export const HOST_CARGO_PACKAGES = Object.freeze(['mizar-desktop']);
export const INSTALLER_CARGO_PACKAGES = Object.freeze([
  'mizar-common',
  'mizar-launcher',
  'mizar-applier',
]);

function locateTomlSection(toml, sectionHeader) {
  const escaped = sectionHeader.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const header = new RegExp(`^\\[${escaped}\\]\\r?$`, 'm').exec(toml);
  if (!header) throw new Error(`Cargo.toml 缺少 [${sectionHeader}] 节`);
  const start = toml.indexOf('\n', header.index) + 1;
  const nextSection = /^\[[^\r\n]+\]\r?$/gm;
  nextSection.lastIndex = start;
  const end = nextSection.exec(toml)?.index ?? toml.length;
  return { start, end, text: toml.slice(start, end) };
}

export function readTomlSectionVersion(toml, sectionHeader) {
  const { text } = locateTomlSection(toml, sectionHeader);
  return text.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
}

export function replaceTomlSectionVersion(toml, sectionHeader, version) {
  const { start, end, text } = locateTomlSection(toml, sectionHeader);
  const ownVersion = /^(version[ \t]*=[ \t]*)"[^"\r\n]+"(?=[ \t]*(?:#[^\r\n]*)?\r?$)/gm;
  if ([...text.matchAll(ownVersion)].length !== 1) {
    throw new Error(`Cargo.toml [${sectionHeader}] 必须包含且仅包含一个 version 字段`);
  }
  return toml.slice(0, start) + text.replace(ownVersion, `$1"${version}"`) + toml.slice(end);
}

export function replaceLockPackageVersions(lock, packageNames, version) {
  let updated = lock;
  for (const name of packageNames) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(
      `(^\\[\\[package\\]\\]\\r?\\nname[ \t]*=[ \t]*"${escaped}"\\r?\\nversion[ \t]*=[ \t]*)"[^"\r\n]+"`,
      'gm',
    );
    if ([...updated.matchAll(pattern)].length !== 1) {
      throw new Error(`Cargo.lock 必须包含且仅包含一个 ${name} 包条目`);
    }
    updated = updated.replace(pattern, `$1"${version}"`);
  }
  return updated;
}

// Cargo is authoritative; Tauri, Installer, and stable release mirrors must agree.
export async function readAppVersion(root = new URL('../../', import.meta.url)) {
  const cargo = await readFile(new URL('apps/desktop/src-tauri/Cargo.toml', root), 'utf8');
  const appVersion = readTomlSectionVersion(cargo, 'package');
  const installerCargo = await readFile(new URL('apps/desktop/installer/Cargo.toml', root), 'utf8');
  const installerVersion = readTomlSectionVersion(installerCargo, 'workspace.package');
  const config = JSON.parse(
    await readFile(new URL('apps/desktop/src-tauri/tauri.conf.json', root), 'utf8'),
  );
  if (!appVersion || config.version !== appVersion) throw new Error('Cargo / Tauri 应用版本不一致');
  if (installerVersion !== appVersion) throw new Error('Cargo / Installer 应用版本不一致');
  if (/^\d+\.\d+\.\d+$/.test(appVersion)) {
    const policy = JSON.parse(
      await readFile(new URL('scripts/qualification/update-release.json', root), 'utf8'),
    );
    if (policy.version !== appVersion) throw new Error('正式版更新发布配置与应用版本不一致');
  }
  return appVersion;
}
export function windowsBundleName(appVersion) {
  validateReleaseTag(`v${appVersion}`, appVersion);
  return `Mizar-v${appVersion}-Windows-x64`;
}
export function validateReleaseTag(tag, appVersion) {
  if (
    !/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:alpha|beta|rc)\.[1-9]\d*)?$/.test(tag) ||
    tag !== `v${appVersion}`
  )
    throw new Error('发布标签与应用版本不一致');
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const version = await readAppVersion();
  if (process.argv[2]) validateReleaseTag(process.argv[2], version);
  console.log(version);
}
