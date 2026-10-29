import { useState } from 'react';
import { OperatorShell } from '../operator/OperatorShell';
import { MulnxToolControls } from '../orchestration/MulnxToolControls';
import { command, openTool, useLocalRead } from '../preparation/client';
import { Button, Field, Panel, StatusBanner } from '../ui';
import './resource-library.css';

type ResourceStatus = {
  packId: string;
  phase: 'missing' | 'downloading' | 'verifying' | 'ready' | 'failed' | 'incompatible';
  activeVersion: string | null;
  preparedVersion: string | null;
  rollbackVersion: string | null;
  failure: string | null;
};
type LibraryView = {
  resources: ResourceStatus[] | null;
  tool: {
    installed: string | null;
    latest: string | null;
    busy: boolean;
    packs: string[];
  } | null;
};
const phases: Record<ResourceStatus['phase'], string> = {
  missing: '暂无独立缓存',
  downloading: '正在准备素材',
  verifying: '正在验证素材',
  ready: '验证完成',
  failed: '最近操作失败',
  incompatible: '素材不兼容',
};

export function ResourceLibraryPage() {
  const view = useLocalRead<LibraryView>('/local/v1/resource-library', 2000);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<'all' | 'media' | 'tool'>('all');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [failed, setFailed] = useState(false);
  const matches = (name: string) =>
    name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
  const resources = view?.resources?.filter((resource) =>
    matches(resource.packId === 'official:epl-default' ? 'EPL 官方示例 素材' : resource.packId),
  );
  const showMedia = category !== 'tool';
  const showTool = category !== 'media' && matches('MulNX 运镜 工具');
  async function checkTool() {
    setBusy(true);
    setMessage('');
    try {
      await command('/operator/orchestration', { action: 'check-tool' });
      setFailed(false);
      setMessage('已检查 MulNX 更新。');
    } catch {
      setFailed(true);
      setMessage('无法检查 MulNX 更新，请稍后重试。');
    } finally {
      setBusy(false);
    }
  }
  return (
    <OperatorShell active="/packages">
      <main className="resource-library">
        <header className="resource-library__heading">
          <div>
            <h1>资源管理</h1>
            <p>查看本机素材和运镜工具的版本与状态。</p>
          </div>
        </header>
        <div className="resource-library__filters">
          <Field
            label="搜索资源"
            type="search"
            placeholder="搜索名称"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <div className="resource-library__categories" aria-label="资源分类">
            {(
              [
                ['all', '全部'],
                ['media', '素材'],
                ['tool', '工具'],
              ] as const
            ).map(([value, label]) => (
              <Button
                key={value}
                variant={category === value ? 'primary' : 'secondary'}
                aria-pressed={category === value}
                onClick={() => setCategory(value)}
              >
                {label}
              </Button>
            ))}
          </div>
        </div>
        {message ? <StatusBanner tone={failed ? 'danger' : 'info'}>{message}</StatusBanner> : null}
        {!view ? (
          <StatusBanner tone="warning">
            正在连接资源状态；如果持续无法连接，请检查本地制播服务。
          </StatusBanner>
        ) : null}
        {view && showMedia && view.resources === null ? (
          <StatusBanner tone="warning">示例素材状态暂不可用。</StatusBanner>
        ) : null}
        {view &&
          showMedia &&
          resources?.map((resource) => (
            <Panel className="resource-library__item" key={resource.packId}>
              <div>
                <span className="resource-library__kind">素材</span>
                <h2>
                  {resource.packId === 'official:epl-default' ? 'EPL 官方示例' : resource.packId}
                </h2>
                <p>{phases[resource.phase]}</p>
              </div>
              <dl>
                <div>
                  <dt>当前版本</dt>
                  <dd>{resource.activeVersion ?? '未启用独立缓存'}</dd>
                </div>
                {resource.preparedVersion ? (
                  <div>
                    <dt>已准备版本</dt>
                    <dd>{resource.preparedVersion}</dd>
                  </div>
                ) : null}
                {resource.rollbackVersion ? (
                  <div>
                    <dt>上一版本</dt>
                    <dd>{resource.rollbackVersion}</dd>
                  </div>
                ) : null}
              </dl>
              {resource.failure ? (
                <Button onClick={() => void openTool('diagnostics')}>查看诊断</Button>
              ) : (
                <a href="/picture">前往播出画面</a>
              )}
            </Panel>
          ))}
        {view && showTool && view.tool ? (
          <Panel className="resource-library__item">
            <div>
              <span className="resource-library__kind">工具</span>
              <h2>MulNX</h2>
              <p>运镜工具与随发行版提供的镜头内容</p>
            </div>
            <dl>
              <div>
                <dt>当前版本</dt>
                <dd>{view.tool.installed ?? '尚未安装'}</dd>
              </div>
              {view.tool.latest ? (
                <div>
                  <dt>最新版本</dt>
                  <dd>{view.tool.latest}</dd>
                </div>
              ) : null}
            </dl>
            <Button disabled={busy || view.tool.busy} onClick={() => void checkTool()}>
              检查更新
            </Button>
            {window.__TAURI_INTERNALS__ ? (
              <div className="resource-library__runtime">
                <MulnxToolControls
                  tool={{
                    installed: view.tool.installed,
                    latest: view.tool.latest,
                    busy: view.tool.busy,
                  }}
                  runtimeOnly
                />
              </div>
            ) : null}
            {view.tool.packs.length ? (
              <details>
                <summary>镜头内容（{view.tool.packs.length}）</summary>
                <ul>
                  {view.tool.packs.map((pack) => (
                    <li key={pack}>{pack}</li>
                  ))}
                </ul>
              </details>
            ) : null}
          </Panel>
        ) : null}
        {view && showTool && !view.tool ? (
          <StatusBanner tone="warning">运镜工具状态暂不可用。</StatusBanner>
        ) : null}
        {view && !(showMedia && (resources?.length || view.resources === null)) && !showTool ? (
          <p>没有找到匹配的资源。</p>
        ) : null}
      </main>
    </OperatorShell>
  );
}
