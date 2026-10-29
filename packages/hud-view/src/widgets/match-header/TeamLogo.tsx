import { useState } from 'react';

/** A neutral badge preserves the graphic slot without inventing team artwork. */
export function TeamLogo({
  team,
  fallback = false,
}: {
  readonly team: { readonly name: string; readonly logoUrl: string | null };
  readonly fallback?: boolean;
}) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  if (team.logoUrl === null || team.logoUrl === failedUrl) {
    return fallback ? (
      <svg
        className="match-header__team-logo"
        viewBox="0 0 40 40"
        role="img"
        aria-label={`${team.name}（队标不可用）`}
      >
        <path
          d="M20 3 34 9v12c0 8-9 14-14 16C15 35 6 29 6 21V9Z"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        />
        <path d="M13 17h14M13 23h14" fill="none" stroke="currentColor" strokeWidth="2" />
      </svg>
    ) : null;
  }
  return (
    <img
      alt={team.name}
      className="match-header__team-logo"
      src={team.logoUrl}
      onError={() => setFailedUrl(team.logoUrl)}
    />
  );
}
