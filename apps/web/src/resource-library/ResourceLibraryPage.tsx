import { useState } from 'react';
import type { MulnxToolView } from '@mizar/protocol/orchestration';
import { BroadcastPresets } from './BroadcastPresets';
import { ResourceModules, type Snapshot } from './ResourceModules';
import { OperatorShell } from '../operator/OperatorShell';
import { MulnxToolControls } from '../orchestration/MulnxToolControls';
import { command, openTool, useLocalRead } from '../preparation/client';
import { Button, Field, Panel, StatusBanner } from '../ui';
import './resource-library.css';

type ResourceStatus = {
  packId: string;
  phase: 'missing' | 'downloading' | 'verifying' | 'ready' | 'failed' | 'incompatible';
  downloadedBytes: number;
  activeVersion: string | null;
  preparedVersion: string | null;
  rollbackVersion: string | null;
  failure: string | null;
};
type LibraryView = {
  resources: ResourceStatus[] | null;
  resourceRecoveryAvailable: boolean;
  bundledEplAvailable: boolean;
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

const resourceFailures: Record<string, string> = {
  resource_authorization_required: '旧缓存尚未获得当前版本授权，请重新准备素材。原缓存证据仍保留。',
  resource_trust_failed: '素材授权验证未通过，不能启用该缓存。请重新准备受信素材。',
  resource_preparation_failed: '素材获取或验证未完成，请查看当前资源诊断后重试。',
  resource_incompatible: '缓存与当前版本不兼容，请重新准备素材。',
  resource_integrity_failed: '缓存文件校验未通过，请重新准备素材。',
  resource_size_mismatch: '缓存文件大小不符，请重新准备素材。',
  resource_file_changed: '缓存文件已变化，请重新准备素材。',
};

export function ResourceLibraryPage() {
  const view = useLocalRead<LibraryView>('/local/v1/resource-library', 2000);
  const [resourceBusy, setResourceBusy] = useState(false);
  const [resourceResult, setResourceResult] = useState('');
  const recoverResource = async (action: 'repair' | 'activate') => {
    setResourceBusy(true);
    setResourceResult('');
    try {
      const result = (await command(
        `/local/v1/resources/official:epl-default/${action}`,
        {},
        undefined,
        610000,
      )) as ResourceStatus;
      setResourceResult(result.preparedVersion ? '素材已准备；结束制作后可启用。' : '素材已启用。');
    } catch (error) {
      setResourceResult(error instanceof Error ? error.message : '操作未完成，请重试。');
    } finally {
      setResourceBusy(false);
    }
  };
  const [broadcastRefresh, setBroadcastRefresh] = useState(0);
  const broadcastSnapshot = useLocalRead<Snapshot>(
    '/local/v1/broadcast-presets',
    2000,
    broadcastRefresh,
  );
  const refreshBroadcast = () => setBroadcastRefresh((value) => value + 1);
  const [query, setQuery] = useState('');
  const [focusPreset, setFocusPreset] = useState<{ id: string; request: number } | null>(null);
  const [category, setCategory] = useState<
    'all' | 'media' | 'tool' | 'music' | 'presets' | 'hud' | 'program' | 'camera'
  >('all');
  const matches = (name: string) =>
    name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
  const resources = view?.resources?.filter((resource) =>
    matches(resource.packId === 'official:epl-default' ? 'EPL 官方示例 素材' : resource.packId),
  );
  const showMedia = category === 'all' || category === 'media';
  const showPresets = category === 'all' || category === 'presets';
  const showModules =
    category === 'all' || ['hud', 'program', 'music', 'camera'].includes(category);
  const showTool = (category === 'all' || category === 'tool') && matches('MulNX 运镜 工具');
  return (
    <OperatorShell active="/packages">
      <main className="resource-library">
        <header className="resource-library__heading">
          <div>
            <h1>资源管理</h1>
            <p>查看播出方案、音乐配置、素材和运镜工具。</p>
          </div>
        </header>
        <details>
          <summary>创建和制作</summary>
          <p>在制作入口创建或编辑内容，保存后返回资源管理。</p>
          <div className="resource-library__actions">
            <a href="/operator/hud">HUD 编辑器</a>
            <a href="/settings?tab=music">音乐制作</a>
            <a href="/settings?tab=camera">运镜制作</a>
          </div>
        </details>
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
                ['hud', 'HUD'],
                ['program', '场景'],
                ['music', '音乐'],
                ['camera', '运镜'],
                ['presets', '方案'],
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
        <ResourceModules
          query={query}
          sharedSnapshot={broadcastSnapshot}
          onRefresh={refreshBroadcast}
          category={category}
          onImported={(presetId) => {
            setCategory('all');
            setQuery('');
            setFocusPreset((previous) =>
              presetId ? { id: presetId, request: (previous?.request ?? 0) + 1 } : null,
            );
          }}
        />
        {showPresets ? (
          <BroadcastPresets
            query={query}
            focusPreset={focusPreset}
            sharedSnapshot={broadcastSnapshot}
            onRefresh={refreshBroadcast}
          />
        ) : null}
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
          resources?.map((resource) => {
            const fullFallback = !resource.activeVersion && view.bundledEplAvailable;
            const Maintenance = fullFallback ? 'details' : 'div';
            return (
              <Panel className="resource-library__item" key={resource.packId}>
                <div>
                  <span className="resource-library__kind">素材</span>
                  <h2>
                    {resource.packId === 'official:epl-default' ? 'EPL 官方示例' : resource.packId}
                  </h2>
                  <p>{fullFallback ? '内置素材可用' : phases[resource.phase]}</p>
                </div>
                <dl>
                  <div>
                    <dt>当前来源</dt>
                    <dd>
                      {resource.activeVersion
                        ? `独立缓存 ${resource.activeVersion}`
                        : view.bundledEplAvailable
                          ? 'Full 随包素材'
                          : '示例素材缺失'}
                    </dd>
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
                {!resource.activeVersion ? (
                  <p>
                    {view.bundledEplAvailable
                      ? '可继续使用内置 EPL 预览，无需先修复独立缓存。'
                      : 'EPL 示例预览暂不可用；不影响真实比赛开播。'}
                  </p>
                ) : null}
                <Maintenance className="resource-library__actions">
                  {fullFallback ? <summary>独立缓存维护（可选）</summary> : null}
                  {resource.failure ? (
                    <StatusBanner tone="warning">
                      {resourceFailures[resource.failure] ?? '独立缓存操作未完成，请重新准备素材。'}
                      <details>
                        <summary>当前资源诊断</summary>
                        <p>
                          {resource.packId} · {resource.failure} · resource_cache_verify
                        </p>
                        <Button onClick={() => void openTool('diagnostics')}>打开完整诊断</Button>
                      </details>
                    </StatusBanner>
                  ) : null}
                  {resource.phase === 'downloading' || resource.phase === 'verifying' ? (
                    <p role="status">
                      {phases[resource.phase]} · 已接收{' '}
                      {(resource.downloadedBytes / 1024 / 1024).toFixed(1)} MiB
                    </p>
                  ) : null}
                  <div className="resource-library__actions">
                    <div>
                      {view.resourceRecoveryAvailable ? (
                        <>
                          <Button
                            disabled={
                              resourceBusy ||
                              resource.phase === 'downloading' ||
                              resource.phase === 'verifying'
                            }
                            onClick={() => void recoverResource('repair')}
                          >
                            {resourceBusy
                              ? '正在处理…'
                              : resource.failure
                                ? '重新准备素材'
                                : '准备当前素材'}
                          </Button>
                          {resource.preparedVersion ? (
                            <Button
                              disabled={resourceBusy}
                              onClick={() => void recoverResource('activate')}
                            >
                              启用已准备素材
                            </Button>
                          ) : null}
                        </>
                      ) : (
                        <p>当前运行环境不提供素材恢复，请使用完整发行包。</p>
                      )}
                    </div>
                  </div>
                </Maintenance>
                <a href="/picture">前往播出画面</a>
                {resourceResult ? <p role="status">{resourceResult}</p> : null}
              </Panel>
            );
          })}
        {view && showTool && view.tool ? (
          <Panel className="resource-library__item">
            <div>
              <span className="resource-library__kind">工具</span>
              <h2>MulNX</h2>
              <p>运镜工具与随发行版提供的镜头内容</p>
            </div>
            <dl>
              <div>
                <dt>已选版本</dt>
                <dd>
                  {view.tool.installed ?? (view.tool.bundled ? '首次启动时自动准备' : '尚未准备')}
                </dd>
              </div>
              {view.tool.bundled ? (
                <div>
                  <dt>随包版本</dt>
                  <dd>{view.tool.bundled}</dd>
                </div>
              ) : null}
              {view.tool.latest ? (
                <div>
                  <dt>
                    {view.tool.checkResult === 'current' || view.tool.checkResult === 'available'
                      ? '上次确认版本'
                      : '已知可用版本'}
                  </dt>
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
        !showModules &&
        !showPresets ? (
          <p>没有找到匹配的资源。</p>
        ) : null}
      </main>
    </OperatorShell>
  );
}
