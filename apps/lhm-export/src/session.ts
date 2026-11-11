import { getObjectiveClockLeaseMs } from '@mizar/core/runtime';
import { avatarUrl, matchTeamIds, parseMatch, type LhmMatch } from './context';
import { createLhmProjection } from './projection';

type Snapshot = NonNullable<ReturnType<ReturnType<typeof createLhmProjection>>>;
const STALE_AFTER_MS = 20_000;
const CURRENT_MATCH_PATH = '/api/match/current';
const NO_CURRENT_MATCH = Symbol('no-current-match');
const NO_AVATAR = Symbol('no-avatar');
const AVATAR_PATH = '/api/players/avatar/steamid/';
const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 15_000] as const;

async function readHostJson(path: string, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(path, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
  });
  // LHM and JT use this endpoint's 404, not a malformed 200 body, for no active match.
  if (response.status === 404) {
    if (path === CURRENT_MATCH_PATH) return NO_CURRENT_MATCH;
    if (path.startsWith(AVATAR_PATH)) return NO_AVATAR;
  }
  if (!response.ok) throw new Error('host data unavailable');
  return response.json() as Promise<unknown>;
}

/** Own one host connection's input, metadata requests and their retirement. */
export function createLhmSession({
  onSnapshot,
  origin,
  readJson = readHostJson,
}: {
  onSnapshot: (snapshot: Snapshot | null) => void;
  origin: string;
  readJson?: (path: string, signal: AbortSignal) => Promise<unknown>;
}) {
  let alive = true;
  let project = createLhmProjection();
  let inputVisible = false;
  let match: LhmMatch | null = null;
  let knownMatchId: string | null | undefined;
  let avatars = new Map<string, string>();
  let requestedAvatars = new Set<string>();
  let currentPlayerIds: readonly string[] = [];
  let metadata = new AbortController();
  const retries = new Set<ReturnType<typeof setTimeout>>();
  let stale: ReturnType<typeof setTimeout> | undefined;
  let objectiveExpiry: ReturnType<typeof setTimeout> | undefined;

  const clearInputTimers = () => {
    clearTimeout(stale);
    clearTimeout(objectiveExpiry);
  };
  const retireMetadata = () => {
    metadata.abort();
    for (const timer of retries) clearTimeout(timer);
    retries.clear();
    metadata = new AbortController();
    match = null;
    avatars = new Map();
    requestedAvatars = new Set();
  };
  const clearInput = () => {
    clearInputTimers();
    inputVisible = false;
    project = createLhmProjection();
    currentPlayerIds = [];
    onSnapshot(null);
  };
  const publishMetadata = () => {
    project.setMetadata(match, avatars);
    if (inputVisible) onSnapshot(project.refresh());
  };
  const request = <T>(
    load: (signal: AbortSignal) => Promise<T>,
    accept: (value: T) => void,
    retryLimit = Infinity,
  ) => {
    const owner = metadata;
    let attempt = 0;
    const current = () => alive && !owner.signal.aborted;
    const run = () => {
      if (!current()) return;
      void load(owner.signal)
        .then((value) => {
          if (current()) accept(value);
        })
        .catch(() => {
          if (!current() || attempt >= retryLimit) return;
          const delay = RETRY_DELAYS_MS[Math.min(attempt++, RETRY_DELAYS_MS.length - 1)]!;
          const timer = setTimeout(() => {
            retries.delete(timer);
            run();
          }, delay);
          retries.add(timer);
        });
    };
    run();
  };
  const loadAvatars = () => {
    for (const id of currentPlayerIds) {
      if (!/^\d{17}$/.test(id) || requestedAvatars.has(id)) continue;
      requestedAvatars.add(id);
      request(
        async (signal) => {
          const value = await readJson(AVATAR_PATH + id, signal);
          if (value === NO_AVATAR) return null;
          const url = avatarUrl(value, origin);
          if (!url) throw new Error('host avatar unavailable');
          return url;
        },
        (url) => {
          if (url === null) return;
          avatars.set(id, url);
          publishMetadata();
        },
        RETRY_DELAYS_MS.length,
      );
    }
  };
  const loadMatch = () => {
    if (!alive) return;
    retireMetadata();
    publishMetadata();
    request(
      async (signal) => {
        const data = await readJson(CURRENT_MATCH_PATH, signal);
        if (data === NO_CURRENT_MATCH) return null;
        const ids = matchTeamIds(data);
        if (!ids) throw new Error('host match unavailable');
        const [a, b] = await Promise.all(
          ids.map((id) => readJson(`/api/teams/${encodeURIComponent(id)}`, signal)),
        );
        const parsed = parseMatch(data, a, b);
        if (!parsed) throw new Error('host match unavailable');
        return parsed;
      },
      (next) => {
        const nextId = next?.id ?? null;
        if (knownMatchId !== undefined && nextId !== knownMatchId) {
          // A different match cannot borrow a previously accepted gameplay frame.
          retireMetadata();
          clearInput();
        }
        knownMatchId = nextId;
        match = next;
        publishMetadata();
      },
    );
    loadAvatars();
  };
  const update = (raw: unknown) => {
    if (!alive) return;
    let next: Snapshot | null;
    try {
      next = project(raw);
    } catch {
      return;
    }
    if (!next) return;
    inputVisible = true;
    onSnapshot(next);
    currentPlayerIds = next.program.payload.players.map((player) => player.sourcePlayerId);
    loadAvatars();
    clearInputTimers();
    objectiveExpiry = setTimeout(
      () => {
        if (alive && inputVisible) onSnapshot(project.refresh());
      },
      getObjectiveClockLeaseMs({ staleAfterMs: STALE_AFTER_MS }) + 1,
    );
    stale = setTimeout(() => {
      inputVisible = false;
      if (alive) onSnapshot(null);
    }, STALE_AFTER_MS);
  };
  return {
    update,
    loadMatch,
    disconnect() {
      if (!alive) return;
      retireMetadata();
      knownMatchId = undefined;
      clearInput();
    },
    dispose() {
      alive = false;
      retireMetadata();
      clearInputTimers();
    },
  };
}
