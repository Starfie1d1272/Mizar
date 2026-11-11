import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { io } from 'socket.io-client';
import { resolvedHudSchema, type ResolvedHudModule } from '@mizar/broadcast-config';
import { AssetProvider, ProgramCanvas, ProgramView } from '@mizar/hud-view';
import type { createLhmProjection } from './projection';
import { createLhmSession } from './session';
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
  const [preset, setPreset] = useState<Extract<ResolvedHudModule, { renderer: 'native' }> | null>(
    null,
  );
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
        const parsed = resolvedHudSchema.parse(value);
        if (parsed.renderer !== 'native') throw new Error('unsupported HUD');
        if (alive) setPreset(parsed);
      })
      .catch(() => {
        if (alive) setPreset(null);
      });
    const socket = io('/');
    const session = createLhmSession({
      onSnapshot: setSnapshot,
      origin: window.location.origin,
    });
    const update = session.update;
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
    socket.on('match', session.loadMatch);
    socket.on('connect', session.loadMatch);
    socket.on('refreshHUD', () => window.location.reload());
    socket.on('disconnect', session.disconnect);
    socket.emit('started');
    return () => {
      alive = false;
      session.dispose();
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
            resolvedPreset={preset.config}
            overlays={preset.overlays}
            accent={preset.accent}
            resolveAssetUrl={resolveAssetUrl}
          />
        </ProgramCanvas>
      </AssetProvider>
    </div>
  );
}
createRoot(document.getElementById('root')!).render(<App />);
