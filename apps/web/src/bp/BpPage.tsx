import { useRef, useState } from 'react';
import { Dialog } from '../ui';
import { RivalHubSyncControls } from '../operator/RivalHubSyncControls';
import { BpControls } from './BpControls';
import { BpLocalEditor } from './BpLocalEditor';
import { BpPresentation } from './BpPresentation';
import type { BpDemoCommand, BpDemoFormat } from '@mizar/protocol/bp';
import { sendBpDemoCommand, switchToRivalhubBp, useBpSession, useBpWorkspace } from './client';
import './bp.css';

const DEMO_MATCHES: Record<BpDemoFormat, { readonly teams: string; readonly title: string }> = {
  bo1: { teams: '示例队伍 A vs 示例队伍 B', title: '单图 BP（合成）' },
  bo3: { teams: 'Falcons vs Natus Vincere', title: 'EPL · 三图 BP' },
  bo5: { teams: '示例队伍 A vs 示例队伍 B', title: '五图 BP（合成）' },
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

export function BpPage() {
  const { snapshot, animate } = useBpSession();
  return <BpPresentation snapshot={snapshot} animate={animate} />;
}

export function BpWorkspaceControls() {
  const { snapshot } = useBpSession();
  const { workspace, connected, loading } = useBpWorkspace();
  const [localEditorOpen, setLocalEditorOpen] = useState(false);
  const editorState = useRef({ dirty: false, saving: false });
  const canCloseEditor = () =>
    !editorState.current.saving &&
    (!editorState.current.dirty || window.confirm('放弃尚未保存的 BP 修改？'));
  const closeEditor = () => {
    if (canCloseEditor()) setLocalEditorOpen(false);
  };
  const [sourceBusy, setSourceBusy] = useState(false);
  const [demoBusy, setDemoBusy] = useState(false);
  const [demoBpRevision, setDemoBpRevision] = useState<string | null>(null);
  const [workspaceMessage, setWorkspaceMessage] = useState('');

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
  const source = demoActive
    ? `演示 · ${demoActive.toUpperCase()}`
    : workspace
      ? sourceLabel(workspace.source)
      : loading
        ? '正在读取'
        : '服务断开';

  return (
    <div className="bp-workspace-controls" data-surface="bp-operator">
      <RivalHubSyncControls />
      <span
        className="bp-source-badge"
        data-source={demoActive ? 'demo' : (workspace?.source ?? 'none')}
      >
        来源：{source}
      </span>
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
              {localSource ? '编辑本地 BP' : workspace?.match ? '补录当前比赛 BP' : '本地填写 BP'}
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
      {localEditorOpen && workspace ? (
        <Dialog
          open
          title="编辑比赛 BP"
          className="bp-editor-dialog"
          canClose={canCloseEditor}
          onClose={() => setLocalEditorOpen(false)}
        >
          <div className="bp-editor-dialog__content">
            <BpLocalEditor
              connected={connected && demoActive === null}
              onStateChange={(state) => {
                editorState.current = state;
              }}
              workspace={workspace}
              onCancel={closeEditor}
              onSaved={(message) => {
                setLocalEditorOpen(false);
                setWorkspaceMessage(message);
              }}
            />
          </div>
        </Dialog>
      ) : demoActive === null && localSource && workspace?.localDraft ? (
        <section className="bp-local-summary" aria-label="本地 BP">
          <div>
            <span className="bp-workspace-eyebrow">本地比赛</span>
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
        <span>BP 画面</span>
      </footer>
    </div>
  );
}
