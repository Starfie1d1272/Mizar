import { useState } from 'react';
import { Button, StatusBanner } from '../ui';
import { useLocalReadWithTime } from './client';

// Read-only projection of the existing Store route; installation stays with the native bridge.
type ResourceStatus = {
  packId: string;
  phase: 'missing' | 'downloading' | 'verifying' | 'ready' | 'failed' | 'incompatible';
  downloadedBytes: number;
  activeVersion: string | null;
  preparedVersion: string | null;
  rollbackVersion: string | null;
  failure: string | null;
};
const phases = {
  missing: '独立缓存未准备',
  downloading: '正在下载',
  verifying: '正在验证',
  ready: '验证完成',
  failed: '素材处理失败',
  incompatible: '素材版本不兼容',
} as const;

export function OfficialResourceStatus() {
  const [refresh, setRefresh] = useState(0);
  const { value, status } = useLocalReadWithTime<{ resources: ResourceStatus[] }>(
    '/local/v1/resources',
    2000,
    refresh,
  );
  return (
    <div aria-label="官方素材缓存状态">
      {status !== 'ready' || !value ? (
        <p role="status">
          {status === 'loading' ? '正在读取官方素材状态。' : '暂时无法读取素材状态，请重新检查。'}
        </p>
      ) : (
        <ul>
          {value.resources.map((resource) => (
            <li key={resource.packId}>
              <strong>
                {resource.packId === 'official:epl-default' ? 'EPL 演练素材' : resource.packId}
              </strong>
              {resource.phase === 'downloading' || resource.phase === 'verifying' ? (
                <p>{phases[resource.phase]}</p>
              ) : null}
              {resource.failure ? (
                <StatusBanner tone="warning">
                  素材处理未完成，请重新检查或查看更新与支持。
                </StatusBanner>
              ) : null}
              <details>
                <summary>版本与诊断</summary>
                <p>
                  {phases[resource.phase]} · 已下载 {resource.downloadedBytes.toLocaleString()} 字节
                </p>
                <p>
                  活动 · {resource.activeVersion ?? '无'}；已准备 ·{' '}
                  {resource.preparedVersion ?? '无'}；可回退 · {resource.rollbackVersion ?? '无'}
                </p>
                {resource.failure ? <p>{resource.failure}</p> : null}
              </details>
            </li>
          ))}
        </ul>
      )}
      <Button onClick={() => setRefresh((current) => current + 1)}>重新读取素材状态</Button>{' '}
      <a href="/settings?tab=advanced">更新与支持</a>
    </div>
  );
}
