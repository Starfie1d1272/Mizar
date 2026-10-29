import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { io } from 'socket.io-client';
import { parseHudResolvedPreset, type HudResolvedPreset } from '@mizar/hud-config';
import { getObjectiveClockLeaseMs } from '@mizar/core/runtime';
import { AssetProvider, ProgramCanvas, ProgramView } from '@mizar/hud-view';
import { createLhmProjection } from './projection';
import { avatarUrl, matchTeamIds, parseMatch, type LhmMatch } from './context';
import '@mizar/design-tokens/tokens.css';
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
import './style.css';

const resolveAssetUrl = (path: string) =>
  new URL(`./mizar-assets/${path.replace(/^\/+/, '')}`, window.location.href).href;
type Snapshot = NonNullable<ReturnType<ReturnType<typeof createLhmProjection>>>;
function App() {
  const [preset, setPreset] = useState<HudResolvedPreset | null>(null);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [scale, setScale] = useState(() =>
    Math.min(window.innerWidth / 1920, window.innerHeight / 1080),
  );
  useEffect(() => {
    const resize = () => setScale(Math.min(window.innerWidth / 1920, window.innerHeight / 1080));
    window.addEventListener('resize', resize);
    let alive = true;
    void fetch('./mizar-config.json')
      .then((response) => {
        if (!response.ok) throw new Error('config unavailable');
        return response.json() as Promise<unknown>;
      })
      .then((value) => {
        if (alive) setPreset(parseHudResolvedPreset(value));
      })
      .catch(() => {
        if (alive) setPreset(null);
      });
    const socket = io('/');
    let project = createLhmProjection();
    let generation = 0;
    let match: LhmMatch | null = null;
    let avatars = new Map<string, string>();
    let requestedAvatars = new Set<string>();
    let currentPlayerIds: readonly string[] = [];
    const publishMetadata = () => {
      project.setMetadata(match, avatars);
      if (alive) setSnapshot(project.refresh());
    };
    const readJson = async (path: string): Promise<unknown> => {
      const response = await fetch(path, { signal: AbortSignal.timeout(8000) });
      if (!response.ok) throw new Error('host data unavailable');
      return response.json() as Promise<unknown>;
    };
    const loadMatch = () => {
      const requestGeneration = ++generation;
      match = null;
      avatars = new Map();
      requestedAvatars = new Set();
      publishMetadata();
      loadAvatars(currentPlayerIds);
      void (async () => {
        const data = await readJson('/api/match/current');
        const ids = matchTeamIds(data);
        if (!ids) return;
        const [a, b] = await Promise.all(
          ids.map((id) => readJson(`/api/teams/${encodeURIComponent(id)}`)),
        );
        if (!alive || requestGeneration !== generation) return;
        match = parseMatch(data, a, b);
        publishMetadata();
      })().catch(() => {});
    };
    const loadAvatars = (ids: readonly string[]) => {
      const requestGeneration = generation;
      for (const id of ids) {
        if (!/^\d{17}$/.test(id) || requestedAvatars.has(id)) continue;
        requestedAvatars.add(id);
        void readJson(`/api/players/avatar/steamid/${id}`)
          .then((value) => {
            if (!alive || requestGeneration !== generation) return;
            const url = avatarUrl(value, window.location.origin);
            if (!url) return;
            avatars.set(id, url);
            publishMetadata();
          })
          .catch(() => {});
      }
    };
    let stale: ReturnType<typeof setTimeout> | undefined;
    let objectiveExpiry: ReturnType<typeof setTimeout> | undefined;
    const update = (raw: unknown) => {
      if (!alive) return;
      let next: Snapshot | null;
      try {
        next = project(raw);
      } catch {
        return;
      }
      if (!next) return;
      setSnapshot(next);
      currentPlayerIds = next.program.payload.players.map((player) => player.sourcePlayerId);
      loadAvatars(currentPlayerIds);
      clearTimeout(objectiveExpiry);
      objectiveExpiry = setTimeout(
        () => {
          if (alive) setSnapshot(project.refresh());
        },
        getObjectiveClockLeaseMs({ staleAfterMs: 20_000 }) + 1,
      );
      clearTimeout(stale);
      stale = setTimeout(() => setSnapshot(null), 20_000);
    };
    let ipc: { receive: (event: string, listener: (raw: unknown) => void) => void } | undefined;
    try {
      ipc = (window.parent as unknown as { ipcApi?: typeof ipc }).ipcApi;
    } catch {
      /* Cross-origin parent has no bridge. */
    }
    if (typeof ipc?.receive !== 'function') ipc = undefined;
    if (typeof ipc?.receive === 'function') ipc.receive('raw', update);
    socket.on('readyToRegister', () => {
      const match = /\/huds\/([^/]+)\//.exec(window.location.pathname);
      if (match)
        socket.emit(
          'register',
          decodeURIComponent(match[1]!),
          false,
          'cs2',
          ipc ? 'IPC' : 'DEFAULT',
        );
    });
    socket.on('update', update);
    socket.on('match', loadMatch);
    socket.on('connect', loadMatch);
    socket.on('refreshHUD', () => window.location.reload());
    socket.on('disconnect', () => {
      generation++;
      match = null;
      avatars = new Map();
      requestedAvatars = new Set();
      currentPlayerIds = [];
      clearTimeout(stale);
      clearTimeout(objectiveExpiry);
      setSnapshot(null);
      project = createLhmProjection();
    });
    socket.emit('started');
    return () => {
      alive = false;
      clearTimeout(stale);
      clearTimeout(objectiveExpiry);
      window.removeEventListener('resize', resize);
      socket.disconnect();
    };
  }, []);
  if (!preset) return null;
  return (
    <div className="viewport" style={{ transform: `scale(${scale})` }}>
      <AssetProvider resolve={resolveAssetUrl}>
        <ProgramCanvas>
          <ProgramView
            kind="hud"
            snapshot={snapshot?.program ?? null}
            radarSnapshot={snapshot?.radar ?? null}
            resolvedPreset={preset}
            resolveAssetUrl={resolveAssetUrl}
          />
        </ProgramCanvas>
      </AssetProvider>
    </div>
  );
}
createRoot(document.getElementById('root')!).render(<App />);
