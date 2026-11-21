import { Button } from '../ui';
import {
  HUD_ANCHORS,
  HUD_CANVAS_HEIGHT,
  HUD_GRID_SIZE,
  HUD_WIDGET_LABELS,
  HUD_WIDGET_REGISTRY,
  resizeRadarPlacement,
  placementToBox,
  type HudConfigDocument,
  type HudLayout,
  type HudPreset,
  type HudTheme,
  type HudWidgetBox,
  type HudWidgetId,
  type HudWidgetPlacement,
} from '@mizar/hud-config';

import { HudWidgetInspector } from './HudWidgetInspector';
import { resourceList } from './hud-console-drafts';
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
  readonly selectedPresetId: string;
  readonly selectedLayoutId: string;
  readonly presetDraft: HudPreset;
  readonly layoutDraft: HudLayout;
  readonly themeDraft: HudTheme;
  readonly layoutDirty: boolean;
  readonly themeDirty: boolean;
  readonly presetNameError: string | null;
  readonly layoutNameError: string | null;
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
}

function isBuiltin(id: string): boolean {
  return id.startsWith('builtin:');
}

function widgetLabel(id: HudWidgetId): string {
  return HUD_WIDGET_LABELS[id];
}

export function HudConsoleWorkspaces({
  workspace,
  configDocument,
  editorReady,
  busy,
  selectedPresetId,
  selectedLayoutId,
  presetDraft,
  layoutDraft,
  layoutDirty,
  presetNameError,
  layoutNameError,
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
}: HudConsoleWorkspaceProps) {
  if (workspace === 'preset') {
    return (
      <section className="hud-console__workspace" aria-label="HUD 预设编辑">
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
          配置组件
          <select
            disabled={!editorReady || busy}
            value={selectedWidgetId ?? ''}
            onChange={(event) => onSelectWidget(event.target.value as HudWidgetId)}
          >
            <option value="" disabled>
              选择组件
            </option>
            {HUD_WIDGET_REGISTRY.filter(
              (widget) => widget.rendererAvailability === 'implemented',
            ).map((widget) => (
              <option key={widget.id} value={widget.id}>
                {widget.label}
              </option>
            ))}
          </select>
        </label>
        {selectedWidgetId === null ? null : (
          <HudWidgetInspector
            key={selectedWidgetId}
            widgetId={selectedWidgetId}
            value={presetDraft.widgets[selectedWidgetId]}
            disabled={!editorReady || busy}
            onChange={(value) =>
              onPresetDraftChange({
                ...presetDraft,
                widgets: { ...presetDraft.widgets, [selectedWidgetId]: value },
              })
            }
          />
        )}
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
            {selectedWidgetId === 'radar' ? (
              <label className="hud-console__field">
                雷达尺寸
                <input
                  max={HUD_CANVAS_HEIGHT}
                  min={1}
                  onChange={(event) => {
                    const width = event.currentTarget.valueAsNumber;
                    onUpdateSelectedPlacement((placement) =>
                      resizeRadarPlacement(
                        placement,
                        width - placementToBox('radar', placement).width,
                        false,
                      ),
                    );
                  }}
                  step={1}
                  type="range"
                  value={Math.round(selectedBox.width)}
                />
              </label>
            ) : null}
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
              <p className="hud-console__hint">用方向键逐像素调整，或拖动雷达右下角。</p>
            ) : null}
          </div>
        )}
        <details
          key={selectedWidgetId === null ? 'choose' : 'selected'}
          open={selectedWidgetId === null}
        >
          <summary>{selectedWidgetId === null ? '组件列表' : '选择其他组件'}</summary>
          <div className="hud-console__widget-list" aria-label="可编辑组件">
            {HUD_WIDGET_REGISTRY.filter(
              (widget) => widget.rendererAvailability === 'implemented',
            ).map(({ id }) => (
              <Button
                aria-label={`选择${widgetLabel(id)}`}
                className={selectedWidgetId === id ? 'is-selected' : undefined}
                key={id}
                onClick={() => onSelectWidget(id)}
                type="button"
              >
                <span>{widgetLabel(id)}</span>
                <small>{layoutDraft.widgets[id].visible ? '显示' : '隐藏'}</small>
              </Button>
            ))}
          </div>
        </details>
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
        <details
          key={layoutNameError ? 'invalid-name' : 'resource'}
          open={layoutNameError !== null}
        >
          <summary>布局资源与名称</summary>
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
              onChange={(event) =>
                onLayoutDraftChange({ ...layoutDraft, name: event.target.value })
              }
            />
          </label>
          {layoutNameError !== null ? (
            <p className="hud-console__field-error" role="alert">
              {layoutNameError}
            </p>
          ) : null}
        </details>
        {isBuiltin(selectedLayoutId) ? (
          <p className="hud-console__hint">内置布局，修改后请另存为副本。</p>
        ) : null}
      </section>
    );
  }

  return null;
}
