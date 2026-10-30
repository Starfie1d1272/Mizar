import { useEffect, useMemo, useSyncExternalStore, type ReactNode } from 'react';

import { ProgramCueEffectProvider } from '@mizar/hud-view';
export { ProgramCueEffectProvider } from '@mizar/hud-view';

import type { ProgramCueClient } from '../realtime/program-cue-client';
import { connectProgramCueRenderer, ProgramCueEffectStore } from './program-cue-effects';

export interface ProgramCueRendererBridgeProps {
  readonly client: ProgramCueClient;
  readonly ttlMs?: number;
  readonly children?: ReactNode;
}

/** Connects accepted Program cues to renderer-local ephemeral presentation state. */
export function ProgramCueRendererBridge({
  client,
  ttlMs = 1_000,
  children,
}: ProgramCueRendererBridgeProps) {
  const store = useMemo(() => new ProgramCueEffectStore({ ttlMs }), [ttlMs]);
  useEffect(() => connectProgramCueRenderer(client, store), [client, store]);
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);

  return (
    <ProgramCueEffectProvider snapshot={snapshot}>
      {children}
      <span aria-hidden="true" data-program-cue-effects={snapshot.effects.length} hidden />
    </ProgramCueEffectProvider>
  );
}
