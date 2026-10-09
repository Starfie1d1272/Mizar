import { useState } from 'react';
import type { HudPreset } from '@mizar/hud-config';
import { useHudConfigClient, useHudConfigEditorClient } from '../realtime/hud-config-client';
import { resourceFor, resourceList } from '../operator/hud-console-drafts';
import { Button, Panel, Select } from '../ui';
import { ProgramPreview } from './ProgramPreview';
import { openTool } from './client';
import { LocalOverlayControls } from './LocalOverlayControls';
import { SpectatorHudCommands } from './SpectatorHudCommands';

export function PictureWorkspace({
  action,
}: {
  action: (run: () => Promise<unknown>) => Promise<void>;
}) {
  const editor = useHudConfigEditorClient();
  const onAir = useHudConfigClient();
  const [selectedId, setSelectedId] = useState(
    new URLSearchParams(window.location.search).get('preset') ?? '',
  );
  const presets = editor.document ? (resourceList(editor.document, 'preset') as HudPreset[]) : [];
  const selected =
    presets.find((preset) => preset.id === selectedId) ??
    presets.find((preset) => preset.id === onAir.current.preset.id) ??
    presets[0];
  return (
    <div className="picture-workspace">
      <Panel className="picture-presets">
        <h2>视觉选择</h2>
        <Select
          label="检查 HUD 预设"
          value={selected?.id ?? ''}
          disabled={editor.status !== 'ready'}
          onChange={(event) => {
            setSelectedId(event.target.value);
            const url = new URL(window.location.href);
            url.searchParams.set('preset', event.target.value);
            window.history.replaceState(null, '', url);
          }}
        >
          {!presets.length ? <option value="">正在读取已保存配置</option> : null}
          {presets.map((preset) => (
            <option key={preset.id} value={preset.id}>
              {preset.name} · {preset.id.startsWith('builtin:') ? '内置' : '自定义'}
            </option>
          ))}
        </Select>
        <h3>
          正式播出 ·{' '}
          {onAir.status === 'loading'
            ? '正在读取'
            : onAir.status === 'ready'
              ? onAir.current.preset.name
              : '无法确认'}
        </h3>
        {onAir.status === 'error' ? (
          <p role="alert">
            {onAir.activeRevision === null
              ? '尚无已确认的播出配置。'
              : `最近确认：${onAir.current.preset.name}；当前启用状态待重查。`}
          </p>
        ) : null}
        {selected && editor.document ? (
          <>
            <p>
              共享布局 ·{' '}
              {resourceFor(editor.document, 'layout', selected.layoutId)?.name ?? selected.layoutId}
              <br />
              共享外观 ·{' '}
              {resourceFor(editor.document, 'theme', selected.themeId)?.name ?? selected.themeId}
            </p>
            <Button
              disabled={editor.status !== 'ready'}
              onClick={() => void action(() => openTool('hud', selected.id))}
            >
              编辑此预设
            </Button>
            <p>
              {onAir.status !== 'ready'
                ? '启用状态待重查。所选配置的样例 / 回放预览请在真实编辑器完成。'
                : selected.id === onAir.current.preset.id
                  ? '节目窗口使用当前正式启用配置。'
                  : '此预设尚未启用。所选配置的样例 / 回放预览请在真实编辑器完成；右侧节目仍使用正式启用配置。'}
            </p>
          </>
        ) : (
          <p>连接未就绪，不使用样例配置冒充已保存选择。</p>
        )}
        <p>选择、编辑保存与启用分别执行；浏览预设不会改变播出。</p>
        <details>
          <summary>本机观战工具 · 不影响正式视觉</summary>
          <LocalOverlayControls />
          <SpectatorHudCommands />
        </details>
        <details>
          <summary>资源与启用详情</summary>
          <p>
            配置状态 · {editor.status === 'ready' ? '已连接' : '待重查'} ·{' '}
            {editor.activationStale ? '保存尚未应用' : '保存与启用分别确认'}
          </p>
          <small>
            资源版本 {editor.revision ?? '未知'} · 启用版本 {onAir.activeRevision ?? '未知'}
          </small>
        </details>
      </Panel>
      <ProgramPreview allowCurrent />
    </div>
  );
}
