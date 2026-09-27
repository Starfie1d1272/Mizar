import {
  HUD_ANCHORS,
  HUD_GRID_SIZE,
  HUD_WIDGET_LABELS,
  HUD_WIDGET_REGISTRY,
  type HudConfigDocument,
  type HudLayout,
  type HudPreset,
  type HudTheme,
  type HudWidgetBox,
  type HudWidgetId,
  type HudWidgetPlacement,
} from '@mizar/hud-config';

import { activePresetId, resourceFor, resourceList } from './hud-console-drafts';
import type { HudWorkspace } from './hud-console-state';

const ANCHOR_LABELS: Record<(typeof HUD_ANCHORS)[number], string> = {
  'top-left': '左上',
  'top-center': '上中',
  'top-right': '右上',
  'center-left': '左中',
  center: '中心',
  'center-right': '右中',
  'bottom-left': '左下',
  'bottom-center': '下中',
  'bottom-right': '右下',
};

export interface HudConsoleWorkspaceProps {
  readonly workspace: HudWorkspace;
  readonly configDocument: HudConfigDocument;
  readonly editorReady: boolean;
  readonly busy: boolean;
  readonly activationStale: boolean;
  readonly hasDirtyDraft: boolean;
  readonly selectedPresetId: string;
  readonly selectedLayoutId: string;
  readonly selectedThemeId: string;
  readonly presetDraft: HudPreset;
  readonly layoutDraft: HudLayout;
  readonly themeDraft: HudTheme;
  readonly presetDirty: boolean;
  readonly layoutDirty: boolean;
  readonly themeDirty: boolean;
  readonly presetNameError: string | null;
  readonly layoutNameError: string | null;
  readonly themeNameError: string | null;
  readonly themeDraftInvalid: boolean;
  readonly selectedWidgetId: HudWidgetId | null;
  readonly selectedPlacement: HudWidgetPlacement | null;
  readonly selectedBox: HudWidgetBox | null;
  readonly showGrid: boolean;
  readonly showCenter: boolean;
  readonly showSafeArea: boolean;
  readonly snapToGridEnabled: boolean;
  readonly onSelectResource: (kind: HudWorkspace, id: string) => void;
  readonly onUpdatePresetReference: (kind: 'layout' | 'theme', id: string) => void;
  readonly onPresetDraftChange: (draft: HudPreset) => void;
  readonly onLayoutDraftChange: (draft: HudLayout) => void;
  readonly onThemeDraftChange: (draft: HudTheme) => void;
  readonly onSelectWidget: (id: HudWidgetId) => void;
  readonly onUpdateSelectedPlacement: (
    update: (placement: HudWidgetPlacement) => HudWidgetPlacement,
    preserveVisualBox?: boolean,
  ) => void;
  readonly onShowGridChange: (value: boolean) => void;
  readonly onShowCenterChange: (value: boolean) => void;
  readonly onShowSafeAreaChange: (value: boolean) => void;
  readonly onSnapToGridChange: (value: boolean) => void;
  readonly onSubmitMutation: (kind: HudWorkspace, saveAs: boolean) => void;
  readonly onDiscard: (kind: HudWorkspace) => void;
  readonly onReset: (kind: HudWorkspace) => void;
  readonly onActivate: () => void;
}

function isBuiltin(id: string): boolean {
  return id.startsWith('builtin:');
}

function widgetLabel(id: HudWidgetId): string {
  return HUD_WIDGET_LABELS[id];
}

function resourceName(resource: HudPreset | HudLayout | HudTheme | undefined): string {
  return resource?.name ?? '未找到资源';
}

export function HudConsoleWorkspaces({
  workspace,
  configDocument,
  editorReady,
  busy,
  activationStale,
  hasDirtyDraft,
  selectedPresetId,
  selectedLayoutId,
  selectedThemeId,
  presetDraft,
  layoutDraft,
  presetDirty,
  layoutDirty,
  presetNameError,
  layoutNameError,
  themeNameError,
  themeDraftInvalid,
  selectedWidgetId,
  selectedPlacement,
  selectedBox,
  showGrid,
  showCenter,
  showSafeArea,
  snapToGridEnabled,
  onSelectResource,
  onUpdatePresetReference,
  onPresetDraftChange,
  onLayoutDraftChange,
  onSelectWidget,
  onUpdateSelectedPlacement,
  onShowGridChange,
  onShowCenterChange,
  onShowSafeAreaChange,
  onSnapToGridChange,
  onSubmitMutation,
  onDiscard,
  onReset,
  onActivate,
}: HudConsoleWorkspaceProps) {
  const activePresetResourceId = activePresetId(configDocument);
  const activePresetName = resourceName(
    resourceFor(configDocument, 'preset', activePresetResourceId),
  );
  const previewMatchesPresetReferences =
    selectedLayoutId === presetDraft.layoutId && selectedThemeId === presetDraft.themeId;
  const activationLabel = hasDirtyDraft
    ? '有未保存更改'
    : !previewMatchesPresetReferences
      ? '预览内容与此预设不一致'
      : selectedPresetId !== activePresetResourceId
        ? '尚未启用'
        : activationStale
          ? '有已保存但未启用的更改'
          : '已启用';

  function renderResourceActions(kind: HudWorkspace, dirty: boolean, id: string) {
    const invalid =
      (kind === 'preset' && presetNameError !== null) ||
      (kind === 'layout' && layoutNameError !== null) ||
      (kind === 'theme' && (themeNameError !== null || themeDraftInvalid));
    return (
      <div className="hud-console__actions">
        <button
          disabled={busy || !editorReady || isBuiltin(id) || invalid}
          onClick={() => onSubmitMutation(kind, false)}
          type="button"
        >
          保存
        </button>
        <button
          disabled={busy || !editorReady || invalid}
          onClick={() => onSubmitMutation(kind, true)}
          type="button"
        >
          另存为
        </button>
        <button
          disabled={busy || !editorReady || !dirty}
          onClick={() => onDiscard(kind)}
          type="button"
        >
          放弃
        </button>
        <button disabled={busy || !editorReady} onClick={() => onReset(kind)} type="button">
          恢复默认
        </button>
      </div>
    );
  }

  if (workspace === 'preset') {
    return (
      <section className="hud-console__workspace" aria-label="HUD 预设编辑">
        <div className="hud-console__workspace-heading">
          <div>
            <span className="hud-console__kicker">预设</span>
            <h2>管理播出预设</h2>
          </div>
        </div>
        <div className="hud-console__preset-status" aria-label="HUD 预设状态">
          <div>
            <span>当前启用</span>
            <strong>{activePresetName}</strong>
          </div>
          <div>
            <span>当前编辑</span>
            <strong>{presetDraft.name.trim() || '未命名预设'}</strong>
          </div>
          <span
            className={
              activationLabel === '已启用'
                ? 'hud-console__badge'
                : 'hud-console__badge hud-console__badge--warning'
            }
          >
            {activationLabel}
          </span>
        </div>
        <label className="hud-console__field">
          预设
          <select
            value={selectedPresetId}
            onChange={(event) => onSelectResource('preset', event.target.value)}
          >
            {resourceList(configDocument, 'preset').map((resource) => (
              <option key={resource.id} value={resource.id}>
                {resource.name}
                {isBuiltin(resource.id) ? ' · 内置只读' : ''}
              </option>
            ))}
          </select>
        </label>
        <label className="hud-console__field">
          名称
          <input
            aria-invalid={presetNameError !== null}
            disabled={!editorReady}
            value={presetDraft.name}
            onChange={(event) => onPresetDraftChange({ ...presetDraft, name: event.target.value })}
          />
        </label>
        {presetNameError !== null ? (
          <p className="hud-console__field-error" role="alert">
            {presetNameError}
          </p>
        ) : null}
        <div className="hud-console__field-grid">
          <label className="hud-console__field">
            布局
            <select
              value={presetDraft.layoutId}
              onChange={(event) => onUpdatePresetReference('layout', event.target.value)}
            >
              {resourceList(configDocument, 'layout').map((resource) => (
                <option key={resource.id} value={resource.id}>
                  {resource.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="hud-console__field">
          雷达视野
          <select
            disabled={!editorReady}
            value={presetDraft.widgets.radar.settings.zoomMode === 'auto' ? 'auto' : 'full-map'}
            onChange={(event) =>
              onPresetDraftChange({
                ...presetDraft,
                widgets: {
                  ...presetDraft.widgets,
                  radar: { variant: 'default', settings: { zoomMode: event.target.value } },
                },
              })
            }
          >
            <option value="full-map">完整地图</option>
            <option value="auto">自动聚焦存活选手</option>
          </select>
        </label>
        {renderResourceActions('preset', presetDirty, selectedPresetId)}
        <button
          className="hud-console__primary-action"
          disabled={busy || !editorReady || hasDirtyDraft || !previewMatchesPresetReferences}
          onClick={onActivate}
          type="button"
        >
          启用当前预设
        </button>
        <p className="hud-console__hint">保存不会改变当前启用项；启用后才会生效。</p>
      </section>
    );
  }

  if (workspace === 'layout') {
    return (
      <section className="hud-console__workspace" aria-label="HUD 布局编辑">
        <div className="hud-console__workspace-heading">
          <div>
            <span className="hud-console__kicker">布局</span>
            <h2>调整组件</h2>
          </div>
          <span className="hud-console__workspace-state">
            {layoutDirty ? '有未保存更改' : `1920 × 1080 · ${HUD_GRID_SIZE}px 网格`}
          </span>
        </div>
        <label className="hud-console__field">
          布局
          <select
            value={selectedLayoutId}
            onChange={(event) => onSelectResource('layout', event.target.value)}
          >
            {resourceList(configDocument, 'layout').map((resource) => (
              <option key={resource.id} value={resource.id}>
                {resource.name}
                {isBuiltin(resource.id) ? ' · 内置只读' : ''}
              </option>
            ))}
          </select>
        </label>
        <label className="hud-console__field">
          名称
          <input
            aria-invalid={layoutNameError !== null}
            disabled={!editorReady}
            value={layoutDraft.name}
            onChange={(event) => onLayoutDraftChange({ ...layoutDraft, name: event.target.value })}
          />
        </label>
        {layoutNameError !== null ? (
          <p className="hud-console__field-error" role="alert">
            {layoutNameError}
          </p>
        ) : null}
        <div className="hud-console__widget-list" aria-label="可编辑组件">
          {HUD_WIDGET_REGISTRY.filter(
            (widget) => widget.rendererAvailability === 'implemented',
          ).map(({ id }) => (
            <button
              aria-label={`选择${widgetLabel(id)}`}
              className={selectedWidgetId === id ? 'is-selected' : undefined}
              key={id}
              onClick={() => onSelectWidget(id)}
              type="button"
            >
              <span>{widgetLabel(id)}</span>
              <small>{layoutDraft.widgets[id].visible ? '显示' : '隐藏'}</small>
            </button>
          ))}
        </div>
        {selectedWidgetId === null || selectedPlacement === null || selectedBox === null ? (
          <div className="hud-console__inspector hud-console__inspector--empty">
            <strong>选择组件</strong>
            <p className="hud-console__hint">点击画布中的组件，或从列表中选择。</p>
          </div>
        ) : (
          <div className="hud-console__inspector">
            <div className="hud-console__inspector-heading">
              <span>组件设置</span>
              <strong>{widgetLabel(selectedWidgetId)}</strong>
            </div>
            <label className="hud-console__check">
              <input
                checked={selectedPlacement.visible}
                onChange={(event) =>
                  onUpdateSelectedPlacement((placement) => ({
                    ...placement,
                    visible: event.target.checked,
                  }))
                }
                type="checkbox"
              />
              显示组件
            </label>
            <label className="hud-console__field">
              锚点
              <select
                value={selectedPlacement.anchor}
                onChange={(event) =>
                  onUpdateSelectedPlacement(
                    (placement) => ({
                      ...placement,
                      anchor: event.target.value as HudWidgetPlacement['anchor'],
                    }),
                    true,
                  )
                }
              >
                {HUD_ANCHORS.map((anchor) => (
                  <option key={anchor} value={anchor}>
                    {ANCHOR_LABELS[anchor]}
                  </option>
                ))}
              </select>
            </label>
            <div className="hud-console__field-grid">
              <label className="hud-console__field">
                X 偏移
                <input
                  inputMode="numeric"
                  onChange={(event) =>
                    onUpdateSelectedPlacement((placement) => ({
                      ...placement,
                      offsetX: Number(event.target.value) || 0,
                    }))
                  }
                  type="number"
                  value={Math.round(selectedPlacement.offsetX)}
                />
              </label>
              <label className="hud-console__field">
                Y 偏移
                <input
                  inputMode="numeric"
                  onChange={(event) =>
                    onUpdateSelectedPlacement((placement) => ({
                      ...placement,
                      offsetY: Number(event.target.value) || 0,
                    }))
                  }
                  type="number"
                  value={Math.round(selectedPlacement.offsetY)}
                />
              </label>
            </div>
            <dl className="hud-console__geometry-meta">
              <div>
                <dt>位置</dt>
                <dd>
                  {Math.round(selectedBox.left)}, {Math.round(selectedBox.top)}
                </dd>
              </div>
              <div>
                <dt>尺寸</dt>
                <dd>
                  {Math.round(selectedBox.width)} × {Math.round(selectedBox.height)}
                </dd>
              </div>
            </dl>
            {selectedWidgetId === 'radar' ? (
              <p className="hud-console__hint">拖动雷达右下角可调整尺寸。</p>
            ) : null}
          </div>
        )}
        <div className="hud-console__guide-controls">
          <label className="hud-console__check">
            <input
              checked={showGrid}
              onChange={(event) => onShowGridChange(event.target.checked)}
              type="checkbox"
            />{' '}
            网格
          </label>
          <label className="hud-console__check">
            <input
              checked={showCenter}
              onChange={(event) => onShowCenterChange(event.target.checked)}
              type="checkbox"
            />{' '}
            中心线
          </label>
          <label className="hud-console__check">
            <input
              checked={showSafeArea}
              onChange={(event) => onShowSafeAreaChange(event.target.checked)}
              type="checkbox"
            />{' '}
            安全区
          </label>
          <label className="hud-console__check">
            <input
              checked={snapToGridEnabled}
              onChange={(event) => onSnapToGridChange(event.target.checked)}
              type="checkbox"
            />{' '}
            吸附到网格
          </label>
        </div>
        {renderResourceActions('layout', layoutDirty, selectedLayoutId)}
      </section>
    );
  }

  return null;
}
