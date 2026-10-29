import { useRef, useState } from 'react';
import { readHudPresetFile } from '../operator/hud-preset-file';
import {
  HudConfigMutationError,
  mutateHudConfig,
  useHudConfigEditorClient,
} from '../realtime/hud-config-client';
import { Button, Panel, StatusBanner } from '../ui';

export function HudPackages() {
  const editor = useHudConfigEditorClient();
  const fileInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'success' | 'danger'; message: string } | null>(
    null,
  );
  async function importFile(file: File) {
    if (!editor.revision || busy) return;
    setBusy(true);
    setNotice(null);
    try {
      const value = await readHudPresetFile(file);
      const result = await mutateHudConfig({
        kind: 'import-preset-pack',
        value,
        expectedEditorRevision: editor.revision,
      });
      editor.applyResponse(result.editor);
      setNotice({
        tone: 'success',
        message: `已保存「${value.preset.name.trim()}」。可前往 HUD 编辑器预览和调整。`,
      });
    } catch (error) {
      setNotice({
        tone: 'danger',
        message:
          error instanceof HudConfigMutationError && error.status === 409
            ? 'HUD 配置已变化，请重试。'
            : error instanceof Error
              ? error.message
              : 'HUD 预设导入失败，请重试。',
      });
    } finally {
      setBusy(false);
    }
  }
  return (
    <Panel className="resource-library__item">
      <div>
        <span className="resource-library__kind">视觉</span>
        <h2>HUD 预设</h2>
        <p>导入已有的 HUD 预设文件。</p>
      </div>
      {notice ? <StatusBanner tone={notice.tone}>{notice.message}</StatusBanner> : <div />}
      <div>
        <input
          ref={fileInput}
          type="file"
          accept=".json,application/json"
          aria-label="选择 HUD 预设文件"
          hidden
          disabled={busy || editor.status !== 'ready'}
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = '';
            if (file) void importFile(file);
          }}
        />
        <Button
          disabled={editor.status !== 'ready'}
          loading={busy}
          onClick={() => fileInput.current?.click()}
        >
          导入 HUD 预设
        </Button>
      </div>
    </Panel>
  );
}
