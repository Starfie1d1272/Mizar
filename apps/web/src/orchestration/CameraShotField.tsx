import type { CameraShot } from '@mizar/protocol/orchestration';
import { Field } from '../ui';

export function Shot({
  label,
  shot,
  change,
}: {
  label: string;
  shot: CameraShot | null;
  change: (shot: CameraShot | null) => void;
}) {
  return (
    <div>
      <Field
        label={label}
        value={shot?.macro ?? ''}
        placeholder="留空不触发"
        onChange={(e) =>
          change(e.target.value ? { macro: e.target.value, maxMs: shot?.maxMs ?? 6000 } : null)
        }
      />
      {shot ? (
        <details>
          <summary>镜头时限</summary>
          <Field
            label="最多持续（秒）"
            type="number"
            min={0.5}
            max={60}
            step={0.001}
            value={shot.maxMs / 1000}
            onChange={(e) => {
              const milliseconds = Number(e.target.value) * 1000;
              const rounded = Math.round(milliseconds);
              change({
                ...shot,
                maxMs: Math.abs(milliseconds - rounded) < 1e-7 ? rounded : milliseconds,
              });
            }}
          />
        </details>
      ) : null}
    </div>
  );
}
