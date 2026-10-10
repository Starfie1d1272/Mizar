// Compact references from docs/screenshots/hud-*.png; never represent the selected live match.
import pulseReference from './hud-reference/pulse.webp';
import eslReference from './hud-reference/esl.webp';
import iemReference from './hud-reference/iem.webp';
import ewcReference from './hud-reference/ewc.webp';
import pwReference from './hud-reference/pw.webp';
import type { HudPreset } from '@mizar/hud-config';
import { useHudConfigClient, useHudConfigEditorClient } from '../realtime/hud-config-client';
import { resourceFor, resourceList } from '../operator/hud-console-drafts';
import { Button } from '../ui';
import { openTool } from './client';

const styleReferences: Record<string, string> = {
  default: pulseReference,
  esl: eslReference,
  iem: iemReference,
  ewc: ewcReference,
  perfectworld: pwReference,
};

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
        HUD 目录{editor.status === 'loading' ? '正在读取' : '连接未就绪，待重查'}。
      </p>
    );
  const document = editor.document;
  return (
    <ul className="hud-preset-directory" aria-label="HUD 预设目录">
      {(resourceList(document, 'preset') as HudPreset[]).map((preset) => (
        <li key={preset.id}>
          <figure>
            <img
              src={styleReferences[preset.widgets['top-score-bar'].variant] ?? pulseReference}
              alt=""
            />
            <figcaption>内置风格参考 · 非本场画面</figcaption>
          </figure>
          <div>
            <strong>{preset.name}</strong> ·{' '}
            {preset.id.startsWith('builtin:') ? '内置只读' : '自定义'} ·{' '}
            {onAir.status !== 'ready'
              ? '启用状态无法确认'
              : onAir.current.preset.id === preset.id
                ? '当前启用'
                : '未启用'}
          </div>
          <details>
            <summary>布局与外观</summary>
            <p>
              布局 · {resourceFor(document, 'layout', preset.layoutId)?.name ?? preset.layoutId}
              ；外观 · {resourceFor(document, 'theme', preset.themeId)?.name ?? preset.themeId}
            </p>
          </details>
          <Button onClick={() => void action(() => openTool('hud', preset.id))}>
            编辑 {preset.name}
          </Button>
        </li>
      ))}
    </ul>
  );
}
