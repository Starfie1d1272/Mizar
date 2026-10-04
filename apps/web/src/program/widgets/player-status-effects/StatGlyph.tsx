export function StatGlyph({ kind }: { readonly kind: 'kills' | 'deaths' }) {
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
