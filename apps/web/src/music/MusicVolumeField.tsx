import { Field } from '../ui';

export function MusicVolumeField({
  label,
  ariaLabel,
  value,
  disabled,
  onChange,
  message,
}: {
  label: string;
  ariaLabel?: string;
  value: number;
  disabled: boolean;
  onChange: (value: number) => void;
  message?: string;
}) {
  return (
    <Field
      label={label}
      aria-label={ariaLabel}
      {...(message === undefined ? {} : { message })}
      type="range"
      min="0"
      max="1"
      step="0.05"
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(Number(event.target.value))}
    />
  );
}
