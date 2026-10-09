import type { HudPreset } from '@mizar/hud-config';
import { useHudConfigClient, useHudConfigEditorClient } from '../realtime/hud-config-client';
import { resourceFor, resourceList } from '../operator/hud-console-drafts';
import { Button } from '../ui';
import { openTool } from './client';

/** Read the existing authoring document; editing remains in the single HUD editor. */
export function HudPresetDirectory({
  action,
}: {
  action: (run: () => Promise<unknown>) => Promise<void>;
}) {
  const editor = useHudConfigEditorClient();
  const onAir = useHudConfigClient();
  if (editor.status !== 'ready' || !editor.document)
    return (
      <p role="status">
        HUD 目录{editor.status === 'loading' ? '正在读取' : '连接未就绪，待重查'}
        ；不使用默认样例冒充已保存资源。
      </p>
    );
  const document = editor.document;
  return (
    <ul aria-label="HUD 预设目录">
      {(resourceList(document, 'preset') as HudPreset[]).map((preset) => (
        <li key={preset.id}>
          <strong>{preset.name}</strong> ·{' '}
          {preset.id.startsWith('builtin:') ? '内置只读' : '自定义'} ·{' '}
          {onAir.status !== 'ready'
            ? '启用状态无法确认'
            : onAir.current.preset.id === preset.id
              ? '当前启用'
              : '未启用'}
          <p>
            布局 · {resourceFor(document, 'layout', preset.layoutId)?.name ?? preset.layoutId}；外观
            · {resourceFor(document, 'theme', preset.themeId)?.name ?? preset.themeId}
          </p>
          <Button onClick={() => void action(() => openTool('hud', preset.id))}>
            编辑 {preset.name}
          </Button>
        </li>
      ))}
    </ul>
  );
}
