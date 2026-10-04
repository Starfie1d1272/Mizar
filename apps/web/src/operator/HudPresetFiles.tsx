import { useRef } from 'react';
import { Button } from '../ui';

export function HudPresetFiles({
  disabled,
  exportDisabled,
  onImport,
  onExport,
}: {
  readonly disabled: boolean;
  readonly exportDisabled: boolean;
  readonly onImport: (file: File) => void;
  readonly onExport: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <div className="hud-console__actions" aria-label="预设文件">
      <input
        ref={input}
        type="file"
        accept=".json,application/json"
        aria-label="选择预设文件"
        hidden
        disabled={disabled}
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = '';
          if (file !== undefined) onImport(file);
        }}
      />
      <Button type="button" disabled={disabled} onClick={() => input.current?.click()}>
        导入预设文件
      </Button>
      <Button type="button" disabled={disabled || exportDisabled} onClick={onExport}>
        导出预设文件
      </Button>
    </div>
  );
}
