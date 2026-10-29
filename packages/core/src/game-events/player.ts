import type { SourceSide } from '../telemetry/map.js';

/** A parser-neutral player reference copied from a game-event callback. */
export interface GameEventPlayerRef {
  /** The source event's userid, not a RivalHub identity. */
  readonly sourceUserId?: number;
  /** A non-empty source SteamID64 when the parser resolved one. */
  readonly sourcePlayerId?: string;
  /** A source-provided display name; never a canonical roster name. */
  readonly displayName?: string;
  readonly side?: SourceSide;
}
