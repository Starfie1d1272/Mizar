import { useEffect, useState } from 'react';
import { Button, Panel, StatusBanner } from '../ui';
import { openTool } from './client';

const phases = {
  missing: '暂无独立缓存',
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
      <h2>示例素材</h2>
      {loading ? (
        <p role="status">正在查询…</p>
      ) : resources === null ? (
        <StatusBanner tone="warning">暂时无法查询，请刷新。</StatusBanner>
      ) : resources.length === 0 ? (
        <p>暂无独立缓存。</p>
      ) : (
        resources.map((resource) => (
          <div key={resource.packId}>
            <p>
              {resource.packId === 'official:epl-default' ? 'EPL 官方示例' : resource.packId} ·{' '}
              {resource.phase === 'ready' && !resource.activeVersion
                ? '已验证，待激活'
                : phases[resource.phase]}
            </p>
            <dl className="settings-identity">
              <div>
                <dt>当前版本</dt>
                <dd>{resource.activeVersion ?? '未激活'}</dd>
              </div>
              {resource.preparedVersion ? (
                <div>
                  <dt>已准备版本</dt>
                  <dd>{resource.preparedVersion}</dd>
                </div>
              ) : null}
            </dl>
            {resource.phase === 'failed' || resource.phase === 'incompatible' ? (
              <Button onClick={() => void openTool('diagnostics')}>查看诊断</Button>
            ) : null}
          </div>
        ))
      )}
      <details className="settings-details">
        <summary>详情</summary>
        {resources
          ?.filter((resource) => resource.failure)
          .map((resource) => (
            <p key={resource.packId}>
              <code>{resource.failure}</code>
            </p>
          ))}
        <p>缓存状态不代表随包素材是否完整。没有活动缓存时，Full 版本仍会尝试读取随包素材。</p>
        <p>
          刷新只查询状态。安装未完成时，可回安装器查看失败提示并重试；其他读取问题请导出诊断包排查。
        </p>
      </details>
      <div className="preparation-actions">
        <Button
          disabled={loading}
          onClick={() => {
            setLoading(true);
            setResources(null);
            setRefresh((value) => value + 1);
          }}
        >
          刷新
        </Button>
      </div>
    </Panel>
  );
}
