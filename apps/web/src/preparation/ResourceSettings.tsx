import { useEffect, useState } from 'react';
import { Button, Panel, StatusBanner } from '../ui';

const phases = {
  missing: '没有活动缓存',
  downloading: '正在准备素材',
  verifying: '正在验证素材',
  ready: '验证完成',
  failed: '最近操作失败',
  incompatible: '素材不兼容',
} as const;

interface ResourceStatus {
  packId: string;
  phase: keyof typeof phases;
  activeVersion: string | null;
  preparedVersion: string | null;
  failure: string | null;
}

// Query the existing Store only. This does not validate bundled Full resources or repair files.
export function ResourceSettings() {
  const [refresh, setRefresh] = useState(0);
  const [resources, setResources] = useState<ResourceStatus[] | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const response = await fetch('/local/v1/resources', {
          cache: 'no-store',
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]),
        });
        if (!response.ok) throw new Error('unavailable');
        const result = (await response.json()) as { resources?: ResourceStatus[] };
        if (
          !Array.isArray(result.resources) ||
          result.resources.some(
            (resource) =>
              !resource ||
              typeof resource.packId !== 'string' ||
              !Object.hasOwn(phases, resource.phase) ||
              !(resource.activeVersion === null || typeof resource.activeVersion === 'string') ||
              !(
                resource.preparedVersion === null || typeof resource.preparedVersion === 'string'
              ) ||
              !(resource.failure === null || typeof resource.failure === 'string'),
          )
        )
          throw new Error('invalid');
        if (!controller.signal.aborted) setResources(result.resources);
      } catch {
        if (!controller.signal.aborted) setResources(null);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    void load();
    return () => controller.abort();
  }, [refresh]);

  return (
    <Panel className="settings-card">
      <h2>官方示例素材</h2>
      <p>
        查看素材缓存状态。没有活动缓存时，Full
        版本仍会尝试读取随包素材；此处不检查随包文件是否完整。
      </p>
      {loading ? (
        <p role="status">正在读取缓存状态…</p>
      ) : resources === null ? (
        <StatusBanner tone="warning">暂时无法查询素材缓存，请重新检查或导出诊断包。</StatusBanner>
      ) : resources.length === 0 ? (
        <p>没有配置官方素材缓存。</p>
      ) : (
        resources.map((resource) => (
          <div key={resource.packId}>
            <p>
              {resource.packId === 'official:epl-default' ? 'EPL 官方示例' : resource.packId} ·{' '}
              {phases[resource.phase]}
            </p>
            <dl className="settings-identity">
              <div>
                <dt>活动版本</dt>
                <dd>{resource.activeVersion ?? '未激活'}</dd>
              </div>
              {resource.preparedVersion ? (
                <div>
                  <dt>已准备版本</dt>
                  <dd>{resource.preparedVersion}</dd>
                </div>
              ) : null}
            </dl>
            {resource.phase === 'ready' && !resource.activeVersion ? (
              <p>素材已验证，尚未激活。</p>
            ) : null}
            {resource.phase === 'failed' || resource.phase === 'incompatible' ? (
              <StatusBanner tone="warning">
                {resource.activeVersion
                  ? '仍保留活动版本，实际读取可能失败。'
                  : '当前没有活动缓存。'}
                请导出诊断包排查。应用内暂不提供素材重新下载；安装未完成时，请回到安装器查看失败提示并重试。
              </StatusBanner>
            ) : null}
            {resource.failure ? (
              <details className="settings-details">
                <summary>错误信息</summary>
                <code>{resource.failure}</code>
              </details>
            ) : null}
          </div>
        ))
      )}
      <div className="preparation-actions">
        <Button
          disabled={loading}
          onClick={() => {
            setLoading(true);
            setResources(null);
            setRefresh((value) => value + 1);
          }}
        >
          重新检查缓存状态
        </Button>
      </div>
    </Panel>
  );
}
