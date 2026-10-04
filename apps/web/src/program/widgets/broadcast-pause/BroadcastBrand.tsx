/** Optional presentation assets supplied by the broadcast host; never gameplay facts. */
export interface BroadcastBranding {
  readonly eventLogoUrl?: string | null;
  readonly broadcasterLogoUrl?: string | null;
  readonly broadcasterName?: string | null;
  readonly platformLogoUrl?: string | null;
  readonly sponsors?: readonly { readonly name: string; readonly logoUrl: string }[];
}

function Logo({
  src,
  label,
  className = '',
}: {
  readonly src: string;
  readonly label: string;
  readonly className?: string;
}) {
  return (
    <img
      className={className}
      src={src}
      alt={label}
      onError={(event) => {
        event.currentTarget.style.visibility = 'hidden';
      }}
    />
  );
}

export function BroadcastBrand({
  branding,
  competition,
  stage,
}: {
  readonly branding?: BroadcastBranding | undefined;
  readonly competition: string | null;
  readonly stage: string | null;
}) {
  return (
    <section className="broadcast-pause__brand" aria-label="Broadcast identity">
      {branding?.eventLogoUrl || competition ? (
        <div className="broadcast-pause__event">
          {branding?.eventLogoUrl ? (
            <Logo src={branding.eventLogoUrl} label={competition ?? 'Event'} />
          ) : null}
          {competition ? <strong>{competition}</strong> : null}
        </div>
      ) : null}
      {stage ? <span className="broadcast-pause__stage">{stage}</span> : null}
      <div
        className="broadcast-pause__brand-main"
        data-event-present={Boolean(competition || branding?.eventLogoUrl)}
      >
        <Logo
          src={branding?.broadcasterLogoUrl ?? '/brand/mizar-mark-mono.svg'}
          label={branding?.broadcasterName ?? 'Mizar'}
        />
        <strong>{branding?.broadcasterName ?? 'MIZAR'}</strong>
      </div>
      {branding?.platformLogoUrl || branding?.sponsors?.length ? (
        <div className="broadcast-pause__partners">
          {branding.platformLogoUrl ? (
            <Logo src={branding.platformLogoUrl} label="Broadcast platform" />
          ) : null}
          {branding.sponsors?.slice(0, 3).map((sponsor) => (
            <Logo
              src={sponsor.logoUrl}
              label={sponsor.name}
              key={`${sponsor.name}:${sponsor.logoUrl}`}
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}
