import { useEffect, useRef, useState } from 'react';
import { ToolShell } from '../patterns';
import { BpControls } from './BpControls';
import { BpLocalEditor } from './BpLocalEditor';
import { BpPresentation } from './BpPresentation';
import type { BpDemoCommand, BpDemoFormat } from '@mizar/protocol/bp';
import { sendBpDemoCommand, switchToRivalhubBp, useBpSession, useBpWorkspace } from './client';
import './bp.css';

const DEMO_MATCHES: Record<BpDemoFormat, { readonly teams: string; readonly title: string }> = {
  bo1: { teams: 'Team Clarys vs Team Plasma', title: '单图 BP' },
  bo3: { teams: "超级无敌大猛男队 vs Team D'avenir", title: '三图 BP' },
  bo5: { teams: 'Team Plasma vs 車一进一宝贝队', title: '五图 BP' },
};

function sourceLabel(source: 'none' | 'online' | 'local' | 'cache' | 'fixture') {
  return source === 'online'
    ? 'RivalHub'
    : source === 'fixture'
      ? '示例比赛'
      : source === 'local'
        ? '本地'
        : source === 'cache'
          ? '本地缓存'
          : '未连接';
}

function readinessLabel(
  readiness: 'unbound' | 'ready' | 'missing' | 'incomplete' | 'conflict',
  connected: boolean,
) {
  if (!connected) return '制作服务断开';
  if (readiness === 'ready') return 'BP 已就绪';
  if (readiness === 'missing') return '当前比赛尚未录入 BP';
  if (readiness === 'incomplete') return 'BP 数据不完整';
  if (readiness === 'conflict') return 'BP 数据存在冲突';
  return '正在读取比赛';
}

export function BpPage({ operator = false }: { readonly operator?: boolean }) {
  const { snapshot, animate } = useBpSession();
  const { workspace, connected, loading } = useBpWorkspace();
  const preview = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const [localEditorOpen, setLocalEditorOpen] = useState(false);
  const [sourceBusy, setSourceBusy] = useState(false);
  const [demoBusy, setDemoBusy] = useState(false);
  const [demoBpRevision, setDemoBpRevision] = useState<string | null>(null);
  const [workspaceMessage, setWorkspaceMessage] = useState('');

  useEffect(() => {
    if (!operator || !preview.current) return;
    const observer = new ResizeObserver((entries) =>
      setScale((entries[0]?.contentRect.width ?? 1920) / 1920),
    );
    observer.observe(preview.current);
    return () => observer.disconnect();
  }, [operator]);

  async function returnToRivalhub() {
    if (!workspace || sourceBusy || !workspace.pendingRivalhub) return;
    setSourceBusy(true);
    setWorkspaceMessage('');
    try {
      setWorkspaceMessage(
        await switchToRivalhubBp(workspace.contextRevision, workspace.pendingRivalhub.revision),
      );
    } catch (error) {
      setWorkspaceMessage(
        error instanceof Error ? error.message : '切换来源失败，当前 BP 保持不变。',
      );
    } finally {
      setSourceBusy(false);
    }
  }

  async function changeDemo(command: BpDemoCommand) {
    if (demoBusy) return;
    setDemoBusy(true);
    setWorkspaceMessage('');
    try {
      const result = await sendBpDemoCommand(command);
      setDemoBpRevision(result.bpRevision);
    } catch (error) {
      setDemoBpRevision(null);
      setWorkspaceMessage(
        error instanceof Error ? error.message : '操作未完成，请检查当前 BP 状态。',
      );
    } finally {
      setDemoBusy(false);
    }
  }

  if (!operator) return <BpPresentation snapshot={snapshot} animate={animate} />;

  const localSource =
    workspace?.source === 'local' ||
    (workspace?.source === 'cache' && workspace.localDraft !== null);
  const demoActive = workspace?.demo.active ?? null;
  const demoSummary = demoActive === null ? null : DEMO_MATCHES[demoActive];
  const status =
    demoActive !== null
      ? 'BP 已就绪'
      : workspace
        ? readinessLabel(workspace.readiness, connected)
        : loading
          ? '正在读取比赛'
          : '制作服务断开';
  const showLocalAuthoring =
    demoActive === null && workspace !== null && (localSource || workspace.readiness !== 'ready');
  const pendingRivalhub = demoActive === null ? workspace?.pendingRivalhub : null;
  const snapshotVisible = snapshot !== null && snapshot.state !== 'hidden';
  const source = demoActive
    ? `演示 · ${demoActive.toUpperCase()}`
    : workspace
      ? sourceLabel(workspace.source)
      : loading
        ? '正在读取'
        : '服务断开';

  return (
    <ToolShell title="BP 工作台">
      <main className="bp-workbench" data-surface="bp-operator">
        <header className="bp-workspace-header">
          <div>
            <span className="bp-workspace-eyebrow">MATCH OPERATIONS</span>
            <h1>BP 制作</h1>
            <p>确认比赛数据后，一键播放完整地图禁选场景。</p>
          </div>
          <span
            className="bp-source-badge"
            data-source={demoActive ? 'demo' : (workspace?.source ?? 'none')}
          >
            来源：{source}
          </span>
        </header>

        <section className="bp-workspace-grid" aria-label="BP 制作工作台">
          <div className="bp-preview-column">
            <div className="bp-preview-label">
              <span>Program Preview</span>
              <small>16:9 · 1920 × 1080</small>
            </div>
            <div className="bp-preview-frame" ref={preview}>
              <div className="bp-preview-scale" style={{ transform: `scale(${scale})` }}>
                <BpPresentation snapshot={snapshot} animate={animate} />
              </div>
              {!snapshotVisible ? (
                <div className="bp-preview-empty" aria-hidden="true">
                  <strong>{status === 'BP 已就绪' ? '地图禁选场景已收起' : status}</strong>
                  <span>
                    {status === 'BP 已就绪' ? '点击右侧“播放 BP”后在此预览' : '全屏场景尚未播放'}
                  </span>
                </div>
              ) : null}
            </div>
            <div className="bp-preview-caption">
              <span>制作预览与 OBS 播出画面共用同一 BP 播放进度</span>
              <a href="/program/bp" target="_blank" rel="noreferrer">
                打开播出画面 ↗
              </a>
            </div>
          </div>

          <aside className="bp-control-panel" aria-label="播出控制">
            <h2>BP 状态</h2>
            {demoSummary ? (
              <section className="bp-demo-active" aria-label="当前 BP 演示">
                <strong>演示模式</strong>
                <span>
                  {demoSummary.teams} · {demoActive?.toUpperCase()}
                </span>
                <small>内置赛事数据</small>
                <button
                  type="button"
                  className="bp-button bp-button--quiet"
                  disabled={demoBusy}
                  onClick={() => void changeDemo({ kind: 'exit' })}
                >
                  退出演示
                </button>
              </section>
            ) : (
              <>
                <div className="bp-source-status">
                  <strong>
                    {workspace
                      ? sourceLabel(workspace.source)
                      : loading
                        ? '正在读取比赛'
                        : '制作服务断开'}
                  </strong>
                  <p>{status}</p>
                  {workspace?.source === 'cache' ? (
                    <small>当前使用本机缓存中的比赛上下文。</small>
                  ) : null}
                </div>
                {workspace?.match ? (
                  <dl className="bp-current-match">
                    <dt>当前比赛 · {workspace.match.format.toUpperCase()}</dt>
                    <dd>
                      {workspace.match.competition}
                      {workspace.match.stage ? ` · ${workspace.match.stage}` : ''}
                    </dd>
                    <dd className="bp-current-teams">
                      <span>{workspace.match.entrants.a.name}</span>
                      <span aria-hidden="true">VS</span>
                      <span>{workspace.match.entrants.b.name}</span>
                    </dd>
                  </dl>
                ) : (
                  <p className="bp-current-match">尚未选择比赛上下文。</p>
                )}
              </>
            )}
            <div
              className="bp-readiness"
              data-state={demoActive !== null ? 'ready' : (workspace?.readiness ?? 'unbound')}
              role="status"
            >
              {status}
            </div>
            <div className="bp-control-actions">
              <BpControls
                snapshot={snapshot}
                showStatus={false}
                disabled={
                  demoBusy ||
                  (demoBpRevision !== null &&
                    snapshot?.state === 'hidden' &&
                    snapshot.revision !== demoBpRevision)
                }
                onCommand={() => setDemoBpRevision(null)}
              />
              {showLocalAuthoring ? (
                <button
                  type="button"
                  className="bp-button"
                  disabled={!connected || sourceBusy}
                  onClick={() => setLocalEditorOpen(true)}
                >
                  {localSource
                    ? '编辑本地 BP'
                    : workspace?.match
                      ? '补录当前比赛 BP'
                      : '本地填写 BP'}
                </button>
              ) : null}
            </div>
            {demoActive !== null ? (
              <p className="bp-real-data-locked">退出演示后可修改真实比赛数据。</p>
            ) : null}
            {demoActive === null && localSource && pendingRivalhub ? (
              <section className="bp-pending-rivalhub" aria-label="待确认的 RivalHub 比赛">
                <strong>RivalHub 数据已恢复</strong>
                <span>
                  {pendingRivalhub.entrants.a.name} vs {pendingRivalhub.entrants.b.name} ·{' '}
                  {pendingRivalhub.format.toUpperCase()}
                </span>
                <small>
                  {pendingRivalhub.competition}
                  {pendingRivalhub.stage ? ` · ${pendingRivalhub.stage}` : ''}
                </small>
                <button
                  type="button"
                  className="bp-button bp-button--quiet"
                  disabled={sourceBusy}
                  onClick={() => void returnToRivalhub()}
                >
                  {sourceBusy ? '正在切换…' : '切回 RivalHub BP'}
                </button>
              </section>
            ) : null}
            {demoActive === null && localSource && !pendingRivalhub ? (
              <p className="bp-rivalhub-note">
                本地 BP 会保持当前播出；RivalHub 数据恢复后，可在这里确认切回。
              </p>
            ) : null}
            <p
              className="bp-workbench-status"
              aria-live="polite"
              role={workspaceMessage ? 'status' : undefined}
            >
              {workspaceMessage}
            </p>
          </aside>
        </section>

        {import.meta.env.DEV ||
        new URLSearchParams(window.location.search).get('qualification') === '1' ? (
          <section className="bp-scene-testing" aria-labelledby="bp-scene-testing-title">
            <div className="bp-demo-heading">
              <h2 id="bp-scene-testing-title">场景测试</h2>
              <p>使用内置赛事数据检查 BP 画面、动画与 OBS 输出，不修改当前比赛。</p>
            </div>
            <div className="bp-demo-options">
              {(['bo1', 'bo3', 'bo5'] as const).map((format) => (
                <article className="bp-demo-option" key={format}>
                  <div>
                    <strong>{format.toUpperCase()}</strong>
                    <span>{DEMO_MATCHES[format].title}</span>
                  </div>
                  <button
                    type="button"
                    className="bp-button"
                    disabled={demoBusy || !connected}
                    onClick={() => void changeDemo({ kind: 'start', format })}
                  >
                    开始演示
                  </button>
                </article>
              ))}
            </div>
          </section>
        ) : null}
        {demoActive === null && localEditorOpen && workspace ? (
          <BpLocalEditor
            key={workspace.contextRevision}
            workspace={workspace}
            onCancel={() => setLocalEditorOpen(false)}
            onSaved={(message) => {
              setLocalEditorOpen(false);
              setWorkspaceMessage(message);
            }}
          />
        ) : demoActive === null && localSource && workspace?.localDraft ? (
          <section className="bp-local-summary" aria-label="本地 BP">
            <div>
              <span className="bp-workspace-eyebrow">LOCAL MATCH</span>
              <h2>本地 BP 已保存</h2>
              <p>
                {workspace.localDraft.entrants.a.name} vs {workspace.localDraft.entrants.b.name} ·{' '}
                {workspace.localDraft.format.toUpperCase()}
              </p>
            </div>
            <button type="button" className="bp-button" onClick={() => setLocalEditorOpen(true)}>
              编辑本地 BP
            </button>
          </section>
        ) : null}

        <footer className="bp-technical-info">
          <strong>OBS Browser Source · /program/bp · 1920 × 1080</strong>
          <span>Veto Scene · 独立全屏场景</span>
        </footer>
      </main>
    </ToolShell>
  );
}
