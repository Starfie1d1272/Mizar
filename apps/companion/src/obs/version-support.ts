import type { ObsRpc } from './reconcile.js';
import { ObsVideoError } from './video-transaction.js';

// Update with the supported OBS stable major when qualifying a new Mizar release.
const SUPPORTED_OBS_MAJOR = 33;

/** Preparation policy only; recovery and output shutdown must remain available. */
export async function requireSupportedObs(obs: ObsRpc): Promise<void> {
  let version: unknown;
  try {
    version = (await obs.call('GetVersion')).obsVersion;
  } catch (cause) {
    throw new ObsVideoError('obs_version_unknown', '无法确认 OBS 版本，请重新检查连接。', {
      cause,
    });
  }
  const parsed = typeof version === 'string' ? /^(\d+)\.\d+\.\d+(-[\w.-]+)?$/.exec(version) : null;
  if (!parsed)
    throw new ObsVideoError('obs_version_unknown', '无法确认 OBS 版本，请重新检查连接。');
  const major = Number(parsed[1]);
  if (major === SUPPORTED_OBS_MAJOR && !parsed[2]) return;
  throw new ObsVideoError(
    'obs_version_unsupported',
    major > SUPPORTED_OBS_MAJOR
      ? `当前 Mizar 支持 OBS ${SUPPORTED_OBS_MAJOR} 稳定版；请更新 Mizar 并核对支持范围。`
      : `当前 OBS ${version} 不受支持，请升级到 OBS ${SUPPORTED_OBS_MAJOR} 稳定版后重新准备。`,
  );
}
