import { readFile } from 'node:fs/promises';
import { fileURLToPath, URL } from 'node:url';

function readTomlSectionVersion(toml, sectionHeader) {
  const header = new RegExp(
    `^\\[${sectionHeader.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]\\r?$`,
    'm',
  ).exec(toml);
  if (!header) return undefined;
  const sectionStart = toml.indexOf('\n', header.index) + 1;
  const nextSection = /^\[[^\r\n]+\]\r?$/gm;
  nextSection.lastIndex = sectionStart;
  const sectionEnd = nextSection.exec(toml)?.index ?? toml.length;
  return toml.slice(sectionStart, sectionEnd).match(/^version\s*=\s*"([^"]+)"/m)?.[1];
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
