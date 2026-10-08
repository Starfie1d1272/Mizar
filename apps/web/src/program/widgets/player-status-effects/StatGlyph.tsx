export function StatGlyph({
  kind,
  filled = false,
}: {
  readonly kind: 'kills' | 'deaths';
  readonly filled?: boolean;
}) {
  return (
    <svg
      data-stat-kind={kind}
      aria-hidden="true"
      className="player-rail__stat-glyph"
      viewBox="0 0 16 16"
    >
      {kind === 'kills' ? (
        <>
          <circle cx="8" cy="8" r="5" />
          <path d="M8 1.5v3M8 11.5v3M1.5 8h3M11.5 8h3" />
        </>
      ) : filled ? (
        <path
          fill="currentColor"
          stroke="none"
          fillRule="evenodd"
          d="M8 1C4.1 1 1.5 3.5 1.5 7v2.2l2.8 1.7V14H6v-2h1v3h2v-3h1v2h1.7v-3.1l2.8-1.7V7C14.5 3.5 11.9 1 8 1ZM3.5 6.5v2l2.8.5.7-2ZM12.5 6.5 9 7l.7 2 2.8-.5ZM8 9l-1.2 2h2.4Z"
        />
      ) : (
        <>
          <path d="M4 7.25a4 4 0 1 1 8 0v2.1c0 .8-.42 1.55-1.1 1.97V14H5.1v-2.68A2.3 2.3 0 0 1 4 9.35z" />
          <circle cx="6.45" cy="7.55" r="0.8" />
          <circle cx="9.55" cy="7.55" r="0.8" />
          <path d="M7 11.1h2M6.25 14v-1.8M8 14v-1.8M9.75 14v-1.8" />
        </>
      )}
    </svg>
  );
}
