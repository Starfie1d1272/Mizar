import { useState } from 'react';
import {
  getHudWidgetDescriptor,
  type HudWidgetDescriptor,
  type HudWidgetId,
  type HudWidgetSettings,
} from '@mizar/hud-config';
import { Checkbox, Select, StatusBanner } from '../ui';

/** Controlled metadata only. Validation runs before any draft update. */
export function HudWidgetInspector({
  widgetId,
  value,
  disabled,
  onChange,
  descriptor = getHudWidgetDescriptor(widgetId),
}: {
  readonly widgetId: HudWidgetId;
  readonly value: HudWidgetSettings;
  readonly disabled: boolean;
  readonly onChange: (value: HudWidgetSettings) => void;
  readonly descriptor?: HudWidgetDescriptor;
}) {
  const [error, setError] = useState<string | null>(null);
  function update(candidate: unknown) {
    try {
      const validated = descriptor.validateSettings(candidate);
      setError(null);
      onChange(validated);
    } catch {
      setError('组件设置无效，请检查后重试。');
    }
  }
  return (
    <div aria-label={`${descriptor.label}内容设置`}>
      {descriptor.supportedVariants.length > 1 ? (
        <Select
          label="呈现方案"
          disabled={disabled}
          value={value.variant}
          onChange={(event) =>
            update({
              variant: event.target.value,
              settings: descriptor.defaultSettingsByVariant[event.target.value],
            })
          }
        >
          {descriptor.supportedVariants.map((variant) => (
            <option key={variant} value={variant}>
              {descriptor.variantLabels[variant]}
            </option>
          ))}
        </Select>
      ) : null}
      {descriptor.editorControls
        .filter((control) => control.variants.includes(value.variant))
        .map((control) =>
          control.type === 'boolean' ? (
            <Checkbox
              key={control.path}
              label={control.label}
              {...(control.help === undefined ? {} : { message: control.help })}
              disabled={disabled}
              checked={value.settings[control.path] === true}
              onChange={(event) =>
                update({
                  ...value,
                  settings: { ...value.settings, [control.path]: event.target.checked },
                })
              }
            />
          ) : (
            <Select
              key={control.path}
              label={control.label}
              disabled={disabled}
              value={String(value.settings[control.path])}
              {...(control.help === undefined ? {} : { message: control.help })}
              onChange={(event) =>
                update({
                  ...value,
                  settings: { ...value.settings, [control.path]: event.target.value },
                })
              }
            >
              {control.options.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          ),
        )}
      {error === null ? null : <StatusBanner tone="danger">{error}</StatusBanner>}
    </div>
  );
}
