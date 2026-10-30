import { useState } from 'react';
import type { MulnxToolView } from '@mizar/protocol/orchestration';
import { OperatorShell } from '../operator/OperatorShell';
import { MulnxToolControls } from '../orchestration/MulnxToolControls';
import { openTool, useLocalRead } from '../preparation/client';
import { loadBuiltinMusic } from '../music/builtin';
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
  tool: (Omit<MulnxToolView, 'packs'> & { packs: string[] }) | null;
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
  const [category, setCategory] = useState<'all' | 'media' | 'tool' | 'music'>('all');
  const [musicBusy, setMusicBusy] = useState(false);
  const [musicMessage, setMusicMessage] = useState('');
  const [musicFailed, setMusicFailed] = useState(false);
  const matches = (name: string) =>
    name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
  const resources = view?.resources?.filter((resource) =>
    matches(resource.packId === 'official:epl-default' ? 'EPL 官方示例 素材' : resource.packId),
  );
  const showMedia = category === 'all' || category === 'media';
  const showTool = (category === 'all' || category === 'tool') && matches('MulNX 运镜 工具');
  const showMusic =
    (category === 'all' || category === 'music') && matches('内置节目音乐 音乐 6首 七组');
  return (
    <OperatorShell active="/packages">
      <main className="resource-library">
        <header className="resource-library__heading">
          <div>
            <h1>资源管理</h1>
            <p>查看本机素材、音乐和运镜工具。</p>
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
                ['music', '音乐'],
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
        {view && showMusic ? (
          <Panel className="resource-library__item">
            <div>
              <span className="resource-library__kind">音乐</span>
              <h2>内置节目音乐</h2>
              <p>6 首曲目，覆盖七组节目场景。来源及使用授权尚未核实。</p>
            </div>
            <p>使用后会替换当前七组音乐配置。</p>
            <div className="resource-library__actions">
              <Button
                disabled={musicBusy}
                onClick={() => {
                  if (!window.confirm('使用内置节目音乐将替换当前七组音乐配置，继续吗？')) return;
                  setMusicBusy(true);
                  setMusicMessage('');
                  setMusicFailed(false);
                  void loadBuiltinMusic()
                    .then(() => setMusicMessage('内置音乐已加载并保存。'))
                    .catch((error: unknown) => {
                      setMusicFailed(true);
                      setMusicMessage(
                        error instanceof Error ? error.message : '内置音乐未加载，原配置已保留。',
                      );
                    })
                    .finally(() => setMusicBusy(false));
                }}
              >
                使用内置音乐
              </Button>
              <a href="/settings?tab=music">编辑音乐设置</a>
              {musicMessage ? (
                <StatusBanner tone={musicFailed ? 'danger' : 'info'}>{musicMessage}</StatusBanner>
              ) : null}
            </div>
          </Panel>
        ) : null}
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
            <div className="resource-library__actions">
              <MulnxToolControls tool={{ ...view.tool, packs: [] }} maintenanceOnly />
            </div>
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
        {view &&
        !(showMedia && (resources?.length || view.resources === null)) &&
        !showTool &&
        !showMusic ? (
          <p>没有找到匹配的资源。</p>
        ) : null}
      </main>
    </OperatorShell>
  );
}
