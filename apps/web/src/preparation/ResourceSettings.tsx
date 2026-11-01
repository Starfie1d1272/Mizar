import { Panel } from '../ui';

export function ResourceSettings() {
  return (
    <Panel className="settings-card">
      <h2>示例素材</h2>
      <p>在资源管理中查看素材版本与状态。</p>
      <a href="/packages?section=dependencies">管理资源</a>
    </Panel>
  );
}
