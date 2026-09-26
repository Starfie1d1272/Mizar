import { useEffect, useRef, useState } from 'react';
import { OperatorShell } from '../operator/OperatorShell';
import { BpControls } from './BpControls';
import { BpLocalEditor } from './BpLocalEditor';
import { BpPresentation } from './BpPresentation';
import { switchToRivalhubBp, useBpSession, useBpWorkspace } from './client';
import './bp.css';

function sourceLabel(source: 'none' | 'online' | 'local' | 'cache') {
  return source === 'online'
    ? 'RivalHub'
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

  if (!operator) return <BpPresentation snapshot={snapshot} animate={animate} />;

  const status = workspace
    ? readinessLabel(workspace.readiness, connected)
    : loading
      ? '正在读取比赛'
      : '制作服务断开';
  const localSource =
    workspace?.source === 'local' ||
    (workspace?.source === 'cache' && workspace.localDraft !== null);
  const showLocalAuthoring = workspace !== null && (localSource || workspace.readiness !== 'ready');
  const pendingRivalhub = workspace?.pendingRivalhub;
  const snapshotVisible = snapshot !== null && snapshot.state !== 'hidden';
  const source = workspace ? sourceLabel(workspace.source) : loading ? '正在读取' : '服务断开';

  return (
    <OperatorShell active="/operator/bp">
      <main className="bp-workbench" data-surface="bp-operator">
        <header className="bp-workspace-header">
          <div>
            <span className="bp-workspace-eyebrow">MATCH OPERATIONS</span>
            <h1>BP 制作</h1>
            <p>确认比赛数据后，一键播放完整地图禁选场景。</p>
          </div>
          <span className="bp-source-badge" data-source={workspace?.source ?? 'none'}>
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
            <div
              className="bp-readiness"
              data-state={workspace?.readiness ?? 'unbound'}
              role="status"
            >
              {status}
            </div>
            <div className="bp-control-actions">
              <BpControls snapshot={snapshot} showStatus={false} />
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
            {localSource && pendingRivalhub ? (
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
            {localSource && !pendingRivalhub ? (
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

        {localEditorOpen && workspace ? (
          <BpLocalEditor
            key={workspace.contextRevision}
            workspace={workspace}
            onCancel={() => setLocalEditorOpen(false)}
            onSaved={(message) => {
              setLocalEditorOpen(false);
              setWorkspaceMessage(message);
            }}
          />
        ) : localSource && workspace?.localDraft ? (
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
    </OperatorShell>
  );
}
