export type SourceBadgeKind = 'sample' | 'live';

/** Pure presentation badge distinguishing sample/fixture previews from live match data. */
export function SourceBadge({
  kind,
  label,
  compact = false,
}: {
  readonly kind: SourceBadgeKind;
  readonly label?: string;
  readonly compact?: boolean;
}) {
  const text =
    label ??
    (kind === 'sample' ? (compact ? '示例' : '示例数据 · 非本场') : compact ? '本场' : '本场实时');
  return (
    <span
      className="mizar-source-badge"
      data-source-kind={kind}
      data-compact={compact || undefined}
    >
      <svg
        className="mizar-source-badge__icon"
        viewBox="0 0 12 12"
        width="12"
        height="12"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        aria-hidden="true"
      >
        {kind === 'sample' ? (
          <path d="M6 1.5L10.5 6L6 10.5L1.5 6Z" />
        ) : (
          <circle cx="6" cy="6" r="3.5" fill="currentColor" stroke="none" />
        )}
      </svg>
      <span>{text}</span>
    </span>
  );
}
