import { useMemo, useState } from 'react';
import { resolveHudPreset, type HudLayout, type HudPreset, type HudTheme } from '@mizar/hud-config';
import { PROGRAM_SCENES, type ProgramSceneId } from '@mizar/protocol/program-scenes';
import {
  mutateHudConfig,
  useHudConfigClient,
  useHudConfigEditorClient,
} from '../realtime/hud-config-client';
import { resourceFor, resourceList } from '../operator/hud-console-drafts';
import { HudCanvasPreview } from '../operator/HudCanvasPreview';
import { getHudEditorFixture } from '../program/fixtures';
import { radarSnapshotForProgramFixture } from '../program/fixtures/radar-fixtures';
import { useBpSession } from '../bp/client';
import { BpPresentation } from '@mizar/hud-view';
import { Button, StatusBanner } from '../ui';
import { openTool } from './client';
import '../operator/hud-console.css';

/** Selecting and inspecting never mutate the active broadcast snapshot. */
export function HudPresetDirectory({
  action,
}: {
  action: (run: () => Promise<unknown>) => Promise<void>;
}) {
  const editor = useHudConfigEditorClient();
  const onAir = useHudConfigClient();
  const { snapshot: bp } = useBpSession();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [scene, setScene] = useState<ProgramSceneId>('gameplay');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const fixture = useMemo(() => getHudEditorFixture('epl-live'), []);
  const radar = useMemo(() => radarSnapshotForProgramFixture('epl-live'), []);
  const presets = editor.document ? (resourceList(editor.document, 'preset') as HudPreset[]) : [];
  const selected = presets.find((p) => p.id === (selectedId ?? onAir.current.preset.id));
  const resolved = (() => {
    if (!selected || !editor.document) return null;
    const layout = resourceFor(editor.document, 'layout', selected.layoutId) as
      HudLayout | undefined;
    const theme = resourceFor(editor.document, 'theme', selected.themeId) as HudTheme | undefined;
    if (!layout || !theme) return null;
    try {
      return resolveHudPreset(selected, layout, theme);
    } catch {
      return null;
    }
  })();
  const active = onAir.status === 'ready' && selected?.id === onAir.current.preset.id;
  const ready = editor.status === 'ready' && onAir.status === 'ready';
  async function apply() {
    if (!ready || !selected || !resolved || !editor.revision || busy) return;
    setBusy(true);
    setMessage('');
    setError('');
    try {
      const response = await mutateHudConfig({
        kind: 'activate-preset',
        sourceId: selected.id,
        expectedEditorRevision: editor.revision,
      });
      editor.applyResponse(response.editor);
      onAir.applyResponse(response.onAir);
      setMessage(`已应用「${response.onAir.resolved.preset.name}」。`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '应用失败，请重试。');
    } finally {
      setBusy(false);
    }
  }
  if (!editor.document)
    return (
      <StatusBanner tone="info">
        {editor.status === 'loading'
          ? '正在读取画面配置…'
          : '画面配置暂时无法连接，请检查制作服务。'}
      </StatusBanner>
    );
  return (
    <section className="picture-workspace" aria-label="选择与预览播出画面">
      <div className="picture-preview-column">
        <nav className="picture-scenes" aria-label="预览节目场景">
          {PROGRAM_SCENES.map((item) => (
            <Button
              key={item.id}
              aria-pressed={scene === item.id}
              variant={scene === item.id ? 'primary' : 'secondary'}
              onClick={() => setScene(item.id)}
            >
              {item.title}
            </Button>
          ))}
        </nav>
        <div className="picture-preview" aria-label="画面预览" data-scene={scene}>
          {scene === 'gameplay' ? (
            resolved ? (
              <HudCanvasPreview
                resolvedPreset={resolved}
                snapshot={fixture}
                radarSnapshot={radar}
                mapBackground
                connectionState="live"
                liveSource={false}
                editorMode="preview"
                editorInteractive={false}
                selectedWidgetId={null}
                showGrid={false}
                showCenter={false}
                showSafeArea={false}
              />
            ) : (
              <p>所选预设不可用，请重新选择。</p>
            )
          ) : scene === 'bp' ? (
            bp?.projection ? (
              <div className="picture-bp-canvas">
                <BpPresentation
                  snapshot={{ ...bp, state: 'shown', revealedCount: bp.projection.steps.length }}
                  animate={false}
                />
              </div>
            ) : (
              <p className="picture-empty">本场暂无完整 BP。现场将按已有比赛资料继续编排。</p>
            )
          ) : (
            <iframe
              key={scene}
              title="节目场景预览"
              src={`${PROGRAM_SCENES.find((item) => item.id === scene)!.path}?preview=1`}
            />
          )}
        </div>
        <div className="picture-preview-caption">
          <span>
            {scene === 'gameplay'
              ? `HUD · ${selected?.name ?? '预设不可用'}`
              : PROGRAM_SCENES.find((item) => item.id === scene)?.title}
          </span>
          <span>
            {scene === 'gameplay' ? '示例数据 · 非本场 · ' : ''}
            仅预览 · 切换场景不影响播出
          </span>
        </div>
      </div>
      <aside className="picture-preset-panel" aria-label="选择 HUD 预设">
        <div className="picture-active">
          <small>当前播出配置</small>
          <strong>
            {onAir.status === 'ready' ? onAir.current.preset.name : '连接异常，状态待确认'}
          </strong>
        </div>
        <h2>选择 HUD</h2>
        <div className="picture-preset-list">
          {presets.map((preset) => (
            <Button
              key={preset.id}
              disabled={busy}
              aria-pressed={selected?.id === preset.id}
              variant={selected?.id === preset.id ? 'primary' : 'secondary'}
              onClick={() => {
                setSelectedId(preset.id);
                setScene('gameplay');
                setMessage('');
                setError('');
              }}
            >
              <span>{preset.name}</span>
              {onAir.status === 'ready' && onAir.current.preset.id === preset.id ? (
                <small>{editor.activationStale ? '有更新待应用' : '已应用'}</small>
              ) : null}
            </Button>
          ))}
        </div>
        <p>HUD 预设用于比赛中画面；其他节目场景在左侧查看。</p>
        <div className="picture-preset-actions">
          <Button
            variant="primary"
            loading={busy}
            disabled={!ready || !resolved || busy || (active && !editor.activationStale)}
            onClick={() => void apply()}
          >
            {active && !editor.activationStale ? '已应用' : '应用'}
          </Button>
          <Button
            disabled={!ready || !resolved || busy}
            onClick={() => void action(() => openTool('hud', selected!.id))}
          >
            调整此预设
          </Button>
        </div>
        {!ready ? <StatusBanner tone="warning">连接未就绪，暂不能应用。</StatusBanner> : null}
        {error ? <StatusBanner tone="danger">{error}</StatusBanner> : null}
        {message ? <StatusBanner tone="info">{message}</StatusBanner> : null}
      </aside>
    </section>
  );
}
