import { StatGlyph } from '../player-status-effects/StatGlyph';
import {
  focusedPlayerSettingsSchema,
  focusedPlayerPresentationSettings,
  type FocusedPlayerSettings,
} from '@mizar/hud-config';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import type { ProjectionCursor } from '@mizar/protocol/shared';
import type { HudWidgetRendererProps } from '../../hud-renderer-registry';
import type { HudDesign } from '../../hud-design';
import { consecutivePresentationSamples } from '../../presentation-sample';
import { observerHotkeyLabel } from '../../observer-hotkey';
import type { PlayerRailAsset } from '../player-rails/presentation';
import {
  CombatTransitionEffects,
  DamageGhost,
  PlayerImpactEffects,
  type CombatFeedbackState,
  useCombatFeedback,
} from '../player-status-effects/combat-feedback';
import { PlayerStatusEffects } from '../player-status-effects/PlayerStatusEffects';
import {
  buildFocusedPlayerPresentation,
  type FocusedPlayerItemKind,
  type FocusedPlayerPresentation,
} from './presentation';

function Icon({ asset }: { readonly asset: PlayerRailAsset | null }) {
  if (asset === null) return null;
  return (
    <span
      className="focused-player__icon"
      role="img"
      aria-label={asset.canonicalKey}
      data-asset-id={asset.canonicalKey}
      style={{ '--focused-icon': `url("${asset.outputPath}")` } as CSSProperties}
    />
  );
}

interface ActiveItemState {
  readonly key: string;
  readonly asset: PlayerRailAsset | null;
  readonly kind: FocusedPlayerItemKind;
  readonly cursor: ProjectionCursor | null;
  readonly presentationRevision: number;
}

function ActiveItemSlot({
  player,
  cursor,
  presentationRevision,
}: {
  readonly player: FocusedPlayerPresentation;
  readonly cursor: ProjectionCursor | null;
  readonly presentationRevision: number;
}) {
  const itemKey = player.activeItem?.item?.canonicalKey ?? player.activeItem?.name ?? 'unavailable';
  const current = useMemo<ActiveItemState>(
    () => ({
      key: itemKey,
      asset: player.activeItem?.asset ?? null,
      kind: player.activeItemKind,
      cursor,
      presentationRevision,
    }),
    [itemKey, player.activeItem?.asset, player.activeItemKind, cursor, presentationRevision],
  );
  const previous = useRef(current);
  const timer = useRef<number | null>(null);
  const [outgoing, setOutgoing] = useState<ActiveItemState | null>(null);
  useEffect(() => {
    const last = previous.current;
    const changed = last.key !== current.key;
    const continuous =
      last.cursor !== null &&
      cursor !== null &&
      consecutivePresentationSamples(
        last.cursor,
        cursor,
        last.presentationRevision,
        presentationRevision,
      );
    previous.current = current;
    if (changed && continuous) {
      if (timer.current !== null) window.clearTimeout(timer.current);
      setOutgoing(last);
      timer.current = window.setTimeout(() => {
        timer.current = null;
        setOutgoing(null);
      }, 120);
    } else if (changed) {
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = null;
      setOutgoing(null);
    }
  }, [
    current,
    itemKey,
    cursor,
    cursor?.producerInstanceId,
    cursor?.liveSessionId,
    cursor?.programSourceGeneration,
    cursor?.programReceiveSequence,
    cursor?.mapEpoch,
    cursor?.runtimeSeq,
    presentationRevision,
  ]);
  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  return (
    <div
      className="focused-player__active"
      aria-label="Active item"
      data-active-item-kind={player.activeItemKind}
      data-active-item-key={itemKey}
      data-item-transition={outgoing !== null}
    >
      {outgoing === null ? null : (
        <span
          aria-hidden="true"
          className="focused-player__item-layer focused-player__item-layer--outgoing"
          data-item-kind={outgoing.kind}
        >
          <Icon asset={outgoing.asset} />
        </span>
      )}
      <span
        className={`focused-player__item-layer${outgoing === null ? '' : ' focused-player__item-layer--incoming'}`}
        data-item-kind={player.activeItemKind}
      >
        <Icon asset={player.activeItem?.asset ?? null} />
      </span>
    </div>
  );
}

function FocusedPlayerFace({
  design,
  player: p,
  options,
  cursor,
  presentationRevision,
  avatarIdentityKey,
  onAvatarReady,
  onAvatarUnavailable,
  outgoing = false,
  incoming = false,
  pending = false,
  combatFeedback = null,
}: {
  readonly design: HudDesign;
  readonly player: FocusedPlayerPresentation;
  readonly options: FocusedPlayerSettings;
  readonly cursor: ProjectionCursor | null;
  readonly presentationRevision: number;
  readonly avatarIdentityKey: string;
  readonly onAvatarReady: (avatarIdentityKey: string) => void;
  readonly onAvatarUnavailable: (avatarIdentityKey: string) => void;
  readonly outgoing?: boolean;
  readonly incoming?: boolean;
  readonly pending?: boolean;
  readonly combatFeedback?: CombatFeedbackState | null;
}) {
  const [displayAvatarUrl, setDisplayAvatarUrl] = useState<string | null>(null);
  const [failedAvatarUrl, setFailedAvatarUrl] = useState<string | null>(null);
  useLayoutEffect(() => {
    const avatarUrl = p.avatarUrl;
    if (!options.showMedia || avatarUrl === null) return;
    if (displayAvatarUrl === avatarUrl || failedAvatarUrl === avatarUrl) return;
    let active = true;
    const image = new Image();
    image.onload = () => {
      if (!active) return;
      setDisplayAvatarUrl(avatarUrl);
      setFailedAvatarUrl(null);
      onAvatarReady(avatarIdentityKey);
    };
    image.onerror = () => {
      if (!active) return;
      setDisplayAvatarUrl(null);
      setFailedAvatarUrl(avatarUrl);
      onAvatarUnavailable(avatarIdentityKey);
    };
    image.src = avatarUrl;
    return () => {
      active = false;
    };
  }, [
    avatarIdentityKey,
    displayAvatarUrl,
    failedAvatarUrl,
    onAvatarReady,
    onAvatarUnavailable,
    p.avatarUrl,
    options.showMedia,
  ]);
  const showAvatar =
    options.showMedia &&
    p.avatarUrl !== null &&
    displayAvatarUrl === p.avatarUrl &&
    failedAvatarUrl !== p.avatarUrl;
  const hotkeyLabel = observerHotkeyLabel(p.observerSlot);
  return (
    <div
      aria-hidden={outgoing || pending || undefined}
      className={`focused-player__face${outgoing ? ' focused-player__face--outgoing' : ''}${incoming ? ' focused-player__face--incoming' : ''}${pending ? ' focused-player__face--pending' : ''}`}
      data-avatar={showAvatar}
      data-media-unavailable={
        !options.showMedia || p.avatarUrl === null || failedAvatarUrl === p.avatarUrl
      }
      data-side={p.side}
      data-dead={p.dead}
    >
      <div className="focused-player__identity">
        <strong className="focused-player__name" title={p.displayName}>
          {p.displayName}
        </strong>
        {options.showMetrics ? (
          <div className="focused-player__metrics" aria-label="K A D ADR">
            <span>
              {design === 'perfectworld' ? <StatGlyph kind="kills" /> : <small>K</small>}
              <b>{p.stats.kills ?? '—'}</b>
            </span>
            <span>
              <small>A</small>
              <b>{p.stats.assists ?? '—'}</b>
            </span>
            <span>
              {design === 'perfectworld' ? <StatGlyph kind="deaths" /> : <small>D</small>}
              <b>{p.stats.deaths ?? '—'}</b>
            </span>
            <span>
              <small>ADR</small>
              <b>
                {(design === 'perfectworld' ? (p.liveAdr ?? p.completedAdr) : p.completedAdr)
                  ?.toFixed(design === 'perfectworld' ? 0 : 1)
                  .replace(/\.0$/, '') ?? '—'}
              </b>
            </span>
          </div>
        ) : null}
      </div>

      <div className="focused-player__action" data-focused-action="true">
        <div
          aria-label={
            showAvatar
              ? `${p.displayName} avatar, observer hotkey ${hotkeyLabel}`
              : `Observer hotkey ${hotkeyLabel}`
          }
          className={`focused-player__media${showAvatar ? ' has-avatar' : ' is-observer-tile'}`}
          data-avatar-slot="true"
          data-side={p.side}
          role={options.showMedia ? 'img' : undefined}
          aria-hidden={!options.showMedia || undefined}
        >
          {options.showMedia && p.avatarUrl !== null && failedAvatarUrl !== p.avatarUrl ? (
            <img
              src={p.avatarUrl}
              alt={`${p.displayName} avatar`}
              style={{ visibility: showAvatar ? 'visible' : 'hidden' }}
              onLoad={() => {
                setDisplayAvatarUrl(p.avatarUrl);
                setFailedAvatarUrl(null);
                onAvatarReady(avatarIdentityKey);
              }}
              onError={() => {
                setDisplayAvatarUrl(null);
                setFailedAvatarUrl(p.avatarUrl);
                onAvatarUnavailable(avatarIdentityKey);
              }}
            />
          ) : null}
          {options.showMedia ? (
            showAvatar ? (
              <span className="focused-player__slot-badge">{hotkeyLabel}</span>
            ) : (
              <strong className="focused-player__observer-tile-number">{hotkeyLabel}</strong>
            )
          ) : null}
        </div>
        <span
          aria-hidden="true"
          className="focused-player__action-gap focused-player__action-gap--a"
        />
        {p.dead ? (
          <div aria-label="Dead" className="focused-player__dead-state">
            <span>{design === 'current' ? 'DEAD' : (p.reportedHealth ?? '—')}</span>
          </div>
        ) : (
          <>
            {design === 'perfectworld' ? (
              <div className="shanghai-focus-utility" aria-label="道具">
                {p.utility
                  .flatMap((item) =>
                    Array.from({ length: item.count }, (_, index) => (
                      <span
                        key={`${item.sourceWeaponId}:${index}`}
                        data-held={item.active && index === 0}
                      >
                        <Icon asset={item.asset} />
                      </span>
                    )),
                  )
                  .slice(0, 4)}
                {p.c4 ? <Icon asset={p.c4} /> : null}
              </div>
            ) : (
              <ActiveItemSlot
                cursor={cursor}
                player={p}
                presentationRevision={presentationRevision}
              />
            )}
            <span
              aria-hidden="true"
              className="focused-player__action-gap focused-player__action-gap--b"
            />
            <div className="focused-player__ammo">
              {design === 'perfectworld' && p.activeItemKind === 'firearm' ? (
                <span className="shanghai-focus-firearm">
                  <Icon asset={p.activeItem?.asset ?? null} />
                </span>
              ) : null}
              {p.clip === null ? null : <strong>{p.clip}</strong>}
              {!options.showReserveAmmo || p.reserveMagazine === null ? null : (
                <span
                  aria-label={`Magazines in reserve: ${p.reserveMagazine.count}`}
                  className="focused-player__reserve-magazines"
                  data-ammo-presentation="magazine"
                >
                  <span
                    aria-hidden="true"
                    className="focused-player__reserve-magazine-icon"
                    data-asset-id={p.reserveMagazine.asset.canonicalKey}
                    style={
                      {
                        '--focused-icon': `url("${p.reserveMagazine.asset.outputPath}")`,
                      } as CSSProperties
                    }
                  />
                  <span>{p.reserveMagazine.count}</span>
                </span>
              )}
              {!options.showReserveAmmo || p.reserveText === null ? null : (
                <span
                  data-ammo-presentation={
                    p.reserveText.startsWith('SHELL ') ? 'shells' : 'reserve-rounds'
                  }
                >
                  {p.reserveText}
                </span>
              )}
            </div>
          </>
        )}
      </div>

      <div className="focused-player__vitals" data-danger={p.health !== null && p.health <= 25}>
        {p.dead ? null : (
          <div className="focused-player__vitals-values">
            <span className="focused-player__health-cluster">
              <strong className="focused-player__hp">{p.health ?? '—'}</strong>
              <span className="focused-player__health-track">
                {p.healthFill === null ? null : <span style={{ width: `${p.healthFill}%` }} />}
                <DamageGhost state={combatFeedback?.damageGhost ?? null} />
              </span>
            </span>
            <span className="focused-player__armor">
              <Icon asset={p.armorAsset} />
              <b>{p.armor ?? '—'}</b>
            </span>
            {design === 'perfectworld' && p.kit ? (
              <span className="shanghai-focus-kit">
                <Icon asset={p.kit} />
              </span>
            ) : null}
          </div>
        )}
      </div>
      {design === 'perfectworld' && p.roundKills != null && p.roundKills > 0 ? (
        <div className="shanghai-focus-kills" aria-label={`Round kills ${p.roundKills}`}>
          <StatGlyph kind="deaths" />
          <b>{p.roundKills}</b>
          <StatGlyph kind="deaths" />
        </div>
      ) : null}
      <PlayerStatusEffects key={`status:${presentationRevision}`} state={p.statusEffects} />
    </div>
  );
}

type FocusedPlayerHandoff = {
  readonly avatarIdentityKey: string;
  readonly outgoing: FocusedPlayerPresentation;
  readonly phase: 'waiting' | 'crossfading';
};

export function FocusedPlayerCard({
  design = 'current',
  player,
  cursor = null,
  presentationRevision = 0,
  options = focusedPlayerSettingsSchema.parse({}),
}: {
  readonly player: FocusedPlayerPresentation;
  readonly design?: HudDesign;
  readonly options?: FocusedPlayerSettings;
  readonly cursor?: ProjectionCursor | null;
  readonly presentationRevision?: number;
}) {
  const combatFeedback = useCombatFeedback({
    sourcePlayerId: player.sourcePlayerId,
    health: player.health,
    dead: player.dead,
    cursor,
    presentationRevision,
  });
  const currentAvatarIdentityKey = `${player.sourcePlayerId}:${player.avatarUrl ?? ''}`;
  const [loadedAvatarIdentityKey, setLoadedAvatarIdentityKey] = useState<string | null>(null);
  const [unavailableAvatarIdentityKey, setUnavailableAvatarIdentityKey] = useState<string | null>(
    null,
  );
  const currentAvatarReady =
    !options.showMedia ||
    player.avatarUrl === null ||
    loadedAvatarIdentityKey === currentAvatarIdentityKey ||
    unavailableAvatarIdentityKey === currentAvatarIdentityKey;
  const [handoff, setHandoff] = useState<FocusedPlayerHandoff | null>(null);
  const onAvatarReady = useCallback((avatarIdentityKey: string) => {
    setLoadedAvatarIdentityKey(avatarIdentityKey);
    setUnavailableAvatarIdentityKey((current) => (current === avatarIdentityKey ? null : current));
    setHandoff((current) =>
      current?.phase === 'waiting' && current.avatarIdentityKey === avatarIdentityKey
        ? { ...current, phase: 'crossfading' }
        : current,
    );
  }, []);
  const onAvatarUnavailable = useCallback((avatarIdentityKey: string) => {
    setUnavailableAvatarIdentityKey(avatarIdentityKey);
    setHandoff((current) =>
      current?.phase === 'waiting' && current.avatarIdentityKey === avatarIdentityKey
        ? { ...current, phase: 'crossfading' }
        : current,
    );
  }, []);
  const previous = useRef<{
    readonly player: FocusedPlayerPresentation;
    readonly cursor: ProjectionCursor | null;
    readonly presentationRevision: number;
  }>({ player, cursor, presentationRevision });
  const timer = useRef<number | null>(null);
  useLayoutEffect(() => {
    const prior = previous.current;
    const changedIdentity = prior.player.sourcePlayerId !== player.sourcePlayerId;
    const continuous =
      prior.cursor !== null &&
      cursor !== null &&
      consecutivePresentationSamples(
        prior.cursor,
        cursor,
        prior.presentationRevision,
        presentationRevision,
      );
    previous.current = { player, cursor, presentationRevision };
    if (!changedIdentity) return;
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    const outgoing = handoff?.phase === 'waiting' ? handoff.outgoing : prior.player;
    // Keep the old face through the same paint that observes the new identity.
    setHandoff(
      !continuous
        ? null
        : {
            avatarIdentityKey: currentAvatarIdentityKey,
            outgoing,
            phase: player.avatarUrl !== null && !currentAvatarReady ? 'waiting' : 'crossfading',
          },
    );
  }, [
    player,
    cursor,
    player.sourcePlayerId,
    cursor?.producerInstanceId,
    cursor?.liveSessionId,
    cursor?.programSourceGeneration,
    cursor?.programReceiveSequence,
    cursor?.mapEpoch,
    cursor?.runtimeSeq,
    presentationRevision,
    currentAvatarReady,
    options.showMedia,
    currentAvatarIdentityKey,
    handoff,
  ]);
  useEffect(() => {
    if (handoff?.phase !== 'crossfading') return;
    const currentHandoff = handoff;
    const timeout = window.setTimeout(() => {
      timer.current = null;
      setHandoff((current) => (current === currentHandoff ? null : current));
    }, 140);
    timer.current = timeout;
    return () => {
      window.clearTimeout(timeout);
      if (timer.current === timeout) timer.current = null;
    };
  }, [handoff]);
  const crossfadeActive = options.showMedia && handoff?.phase === 'crossfading';
  return (
    <article
      aria-label="Focused player"
      className="focused-player"
      data-show-metrics={options.showMetrics}
      data-focused-player={player.sourcePlayerId}
      data-avatar={
        options.showMedia && loadedAvatarIdentityKey === currentAvatarIdentityKey ? true : undefined
      }
      data-side={player.side}
      data-dead={player.dead}
      data-observer-transition={crossfadeActive}
    >
      {!options.showMedia || handoff === null ? null : (
        <FocusedPlayerFace
          design={design}
          key={`outgoing:${handoff.outgoing.sourcePlayerId}:${handoff.outgoing.avatarUrl ?? ''}`}
          options={options}
          avatarIdentityKey={`${handoff.outgoing.sourcePlayerId}:${handoff.outgoing.avatarUrl ?? ''}`}
          cursor={null}
          onAvatarReady={onAvatarReady}
          onAvatarUnavailable={onAvatarUnavailable}
          outgoing={crossfadeActive}
          player={handoff.outgoing}
          presentationRevision={presentationRevision}
        />
      )}
      <FocusedPlayerFace
        design={design}
        key={`current:${player.sourcePlayerId}:${player.avatarUrl ?? ''}`}
        options={options}
        avatarIdentityKey={currentAvatarIdentityKey}
        combatFeedback={combatFeedback}
        cursor={cursor}
        incoming={crossfadeActive}
        onAvatarReady={onAvatarReady}
        onAvatarUnavailable={onAvatarUnavailable}
        pending={options.showMedia && handoff?.phase === 'waiting'}
        player={player}
        presentationRevision={presentationRevision}
      />
      <PlayerImpactEffects sourcePlayerId={player.sourcePlayerId} surface="focused" />
      <CombatTransitionEffects feedback={combatFeedback} surface="focused" />
    </article>
  );
}

export function FocusedPlayer({
  design = 'current',
  snapshot,
  settings,
  presentationRevision = 0,
}: HudWidgetRendererProps) {
  const options = focusedPlayerPresentationSettings(settings);
  const player = buildFocusedPlayerPresentation(snapshot.payload);
  return player === null ? null : (
    <FocusedPlayerCard
      design={design}
      options={options}
      cursor={snapshot.cursor}
      player={player}
      presentationRevision={presentationRevision}
    />
  );
}
