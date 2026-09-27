import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import type { ProjectionCursor } from '@mizar/protocol/shared';

import { useProgramCueEffectsForPlayer } from '../../ProgramCueRendererBridge';
import { consecutivePresentationSamples } from '../../presentation-sample';

export interface DamageGhostState {
  readonly key: number;
  readonly fromPercent: number;
  readonly toPercent: number;
}

export interface CombatFeedbackState {
  readonly damageGhost: DamageGhostState | null;
  readonly deathPulseKey: number | null;
  readonly lowHealthPulseKey: number | null;
}

interface CombatSample {
  readonly sourcePlayerId: string;
  readonly health: number | null;
  readonly dead: boolean;
  readonly cursor: ProjectionCursor | null;
  readonly presentationRevision: number;
}

const EMPTY_FEEDBACK: CombatFeedbackState = {
  damageGhost: null,
  deathPulseKey: null,
  lowHealthPulseKey: null,
};

function healthPercent(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, value));
}

export function useCombatFeedback({
  sourcePlayerId,
  health,
  dead,
  cursor,
  presentationRevision,
}: CombatSample): CombatFeedbackState {
  const [feedback, setFeedback] = useState<CombatFeedbackState>(EMPTY_FEEDBACK);
  const previous = useRef<CombatSample | null>(null);
  const activeGhost = useRef<DamageGhostState | null>(null);
  const sequence = useRef(0);
  const damageTimer = useRef<number | null>(null);

  useLayoutEffect(() => {
    const current = { sourcePlayerId, health, dead, cursor, presentationRevision };
    const prior = previous.current;
    previous.current = current;
    if (prior === null) return;

    const previousSequence =
      prior.cursor?.programReceiveSequence ?? prior.cursor?.runtimeSeq ?? null;
    const currentSequence = cursor?.programReceiveSequence ?? cursor?.runtimeSeq ?? null;
    const samePresentationSample =
      prior.sourcePlayerId === sourcePlayerId &&
      prior.health === health &&
      prior.dead === dead &&
      prior.presentationRevision === presentationRevision &&
      prior.cursor !== null &&
      cursor !== null &&
      prior.cursor.producerInstanceId === cursor.producerInstanceId &&
      prior.cursor.liveSessionId === cursor.liveSessionId &&
      prior.cursor.programSourceGeneration === cursor.programSourceGeneration &&
      prior.cursor.mapEpoch === cursor.mapEpoch &&
      previousSequence === currentSequence;
    if (samePresentationSample) return;

    const continuous =
      prior.sourcePlayerId === sourcePlayerId &&
      cursor !== null &&
      consecutivePresentationSamples(
        prior.cursor,
        cursor,
        prior.presentationRevision,
        presentationRevision,
      );

    if (!continuous) {
      if (damageTimer.current !== null) window.clearTimeout(damageTimer.current);
      damageTimer.current = null;
      activeGhost.current = null;
      // Presentation boundaries snap to current truth instead of replaying combat motion.
      setFeedback((value) => (value === EMPTY_FEEDBACK ? value : EMPTY_FEEDBACK));
      return;
    }

    const previousHealth = prior.dead ? 0 : healthPercent(prior.health);
    const currentHealth = dead ? 0 : healthPercent(health);
    const deathStarted = !prior.dead && dead;
    const lowHealthStarted =
      !dead &&
      previousHealth !== null &&
      currentHealth !== null &&
      previousHealth > 25 &&
      currentHealth <= 25;
    const healthRestored =
      !dead && previousHealth !== null && currentHealth !== null && currentHealth > previousHealth;

    if (healthRestored || (prior.dead && !dead)) {
      if (damageTimer.current !== null) window.clearTimeout(damageTimer.current);
      damageTimer.current = null;
      activeGhost.current = null;
      // A new life/round must not inherit damage presentation from the previous one.
      setFeedback((value) => (value === EMPTY_FEEDBACK ? value : EMPTY_FEEDBACK));
      return;
    }

    let damageGhost: DamageGhostState | null = null;
    if (previousHealth !== null && currentHealth !== null && currentHealth < previousHealth) {
      damageGhost = {
        key: ++sequence.current,
        fromPercent: Math.max(activeGhost.current?.fromPercent ?? previousHealth, previousHealth),
        toPercent: currentHealth,
      };
      activeGhost.current = damageGhost;
      if (damageTimer.current !== null) window.clearTimeout(damageTimer.current);
      damageTimer.current = window.setTimeout(() => {
        damageTimer.current = null;
        activeGhost.current = null;
        setFeedback((value) =>
          value.damageGhost === damageGhost ? { ...value, damageGhost: null } : value,
        );
      }, 380);
    }

    if (damageGhost === null && !deathStarted && !lowHealthStarted) return;
    // Gameplay truth is already current; this state only describes the short handoff.
    setFeedback((value) => ({
      damageGhost: damageGhost ?? value.damageGhost,
      deathPulseKey: deathStarted ? ++sequence.current : value.deathPulseKey,
      lowHealthPulseKey: lowHealthStarted
        ? ++sequence.current
        : deathStarted
          ? null
          : value.lowHealthPulseKey,
    }));
  }, [
    cursor,
    cursor?.liveSessionId,
    cursor?.mapEpoch,
    cursor?.producerInstanceId,
    cursor?.programReceiveSequence,
    cursor?.programSourceGeneration,
    cursor?.runtimeSeq,
    dead,
    health,
    presentationRevision,
    sourcePlayerId,
  ]);

  useEffect(
    () => () => {
      if (damageTimer.current !== null) window.clearTimeout(damageTimer.current);
    },
    [],
  );

  return feedback;
}

export function DamageGhost({ state }: { readonly state: DamageGhostState | null }) {
  if (state === null || state.fromPercent <= state.toPercent) return null;
  return (
    <span
      aria-hidden="true"
      className="combat-damage-ghost"
      data-damage-ghost="true"
      key={state.key}
      style={
        {
          '--rh-damage-from': `${state.fromPercent}%`,
          '--rh-damage-to': `${state.toPercent}%`,
        } as CSSProperties
      }
    />
  );
}

export function CombatTransitionEffects({
  feedback,
  surface,
}: {
  readonly feedback: CombatFeedbackState;
  readonly surface: 'rail' | 'focused';
}) {
  return (
    <div aria-hidden="true" className="player-combat-transition" data-surface={surface}>
      {feedback.deathPulseKey === null ? null : (
        <span
          className="player-combat-transition__death"
          data-combat-transition="death"
          key={`death:${feedback.deathPulseKey}`}
        />
      )}
      {feedback.lowHealthPulseKey === null ? null : (
        <span
          className="player-combat-transition__low-health"
          data-combat-transition="low-health"
          key={`low:${feedback.lowHealthPulseKey}`}
        />
      )}
    </div>
  );
}

export function PlayerImpactEffects({
  sourcePlayerId,
  anchor = 'center',
  surface,
}: {
  readonly sourcePlayerId: string;
  readonly anchor?: 'left' | 'right' | 'center';
  readonly surface: 'rail' | 'focused';
}) {
  const effects = useProgramCueEffectsForPlayer(sourcePlayerId).filter(
    ({ cue }) => cue.kind === 'player-impact',
  );
  if (effects.length === 0) return null;

  return (
    <div
      aria-hidden="true"
      className="player-combat-impact-effects"
      data-anchor={anchor}
      data-surface={surface}
    >
      {effects.map(({ cue }) =>
        cue.kind === 'player-impact' ? (
          <span
            className={`player-combat-impact player-combat-impact--${cue.effect}`}
            data-lethal={cue.lethal}
            data-player-impact={cue.effect}
            key={cue.id}
          />
        ) : null,
      )}
    </div>
  );
}
