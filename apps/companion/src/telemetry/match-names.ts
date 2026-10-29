import { matchPlayerDisplayName } from '@mizar/core/projection';
import type { MatchContextBinding } from '../match-context/lkg-store.js';

/** Only a website-bound match supplies game replacements. */
export function matchNames(binding: MatchContextBinding | undefined): Map<string, string> {
  const names = new Map<string, string>();
  if (
    !binding ||
    binding.localAuthoringMode === 'standalone' ||
    !(
      binding.origin === 'online' ||
      binding.cachedFrom === 'online' ||
      binding.localAuthoringMode === 'bound-overlay'
    )
  )
    return names;
  const context = binding.context;
  for (const player of [...context.entrants.a.players, ...context.entrants.b.players]) {
    if (player.steam64 === null) continue;
    const name = matchPlayerDisplayName(context, player.steam64);
    if (name && !name.includes('\0') && Buffer.byteLength(name, 'utf8') <= 127)
      names.set(player.steam64, name);
  }
  return names.size <= 64 ? names : new Map<string, string>();
}

export function nameWire(id: string, name: string): string {
  const quoted = `"${name.replace(/[\\"]/g, '\\$&')}"`;
  return JSON.stringify({ type: 'Name/Player/Set', payload: `${quoted} ${id}` });
}

/** Gateway acknowledgements confirm queueing only. */
export class MatchNameSync {
  private socket: WebSocket | null = null;
  private session: string | null = null;
  private owned = new Map<string, string>();
  private replay = false;
  private busy = false;
  private stopped = false;
  private retryAt = 0;
  constructor(
    private readonly snapshot: () => { session: string | null; names: Map<string, string> },
  ) {}

  async tick() {
    if (this.busy || this.stopped) return;
    this.busy = true;
    try {
      const current = this.snapshot();
      if (current.session === null) {
        await this.clearConnected();
        this.socket?.close();
        this.socket = null;
        return;
      }
      if (current.session !== this.session) {
        await this.clearConnected();
        this.socket?.close();
        this.socket = null;
        this.owned.clear();
        this.session = current.session;
        this.replay = true;
      }
      if (current.names.size === 0 && this.owned.size === 0) return;
      if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
        if (Date.now() < this.retryAt) return;
        this.retryAt = Date.now() + 3000;
        if (!(await this.connect())) return;
        this.replay = true;
      }
      const desired = current.names;
      const intent = JSON.stringify([...desired].sort(([a], [b]) => a.localeCompare(b)));
      const currentIntent = () => {
        const latest = this.snapshot();
        return (
          latest.session === current.session &&
          JSON.stringify([...latest.names].sort(([a], [b]) => a.localeCompare(b))) === intent
        );
      };
      for (const id of this.owned.keys()) {
        if (desired.has(id)) continue;
        if (!currentIntent() || !(await this.send(id, ''))) return;
        this.owned.delete(id);
        if (!currentIntent()) return;
      }
      for (const [id, name] of desired) {
        if (!this.replay && this.owned.get(id) === name) continue;
        if (!currentIntent()) return;
        // A lost acknowledgement may still have reached the game; retain the UID for cleanup.
        if (!(await this.send(id, name, () => this.owned.set(id, name)))) return;
        if (!currentIntent()) return;
      }
      this.replay = false;
    } finally {
      this.busy = false;
    }
  }
  private async connect(): Promise<boolean> {
    const socket = new WebSocket('ws://127.0.0.1:55202');
    this.socket = socket;
    return new Promise((resolve) => {
      let done = false;
      const finish = (ok: boolean) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (!ok) {
          if (this.socket === socket) this.socket = null;
          socket.close();
        }
        resolve(ok);
      };
      const timer = setTimeout(() => finish(false), 1000);
      socket.addEventListener('open', () => finish(true), { once: true });
      socket.addEventListener('error', () => finish(false), { once: true });
      socket.addEventListener('close', () => finish(false), { once: true });
    });
  }
  private send(id: string, name: string, submitted?: () => void): Promise<boolean> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return Promise.resolve(false);
    const wire = nameWire(id, name);
    return new Promise((resolve) => {
      let done = false;
      const finish = (ok: boolean) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        socket.removeEventListener('message', message);
        socket.removeEventListener('close', closed);
        if (!ok) {
          if (this.socket === socket) this.socket = null;
          socket.close();
        }
        resolve(ok);
      };
      const message = ({ data }: MessageEvent) => {
        if (data === `已投入消息总线${wire}`) finish(true);
        else if (typeof data === 'string' && data.startsWith(`error: ${wire} desc: `))
          finish(false);
      };
      const closed = () => finish(false);
      const timer = setTimeout(() => finish(false), 1500);
      socket.addEventListener('message', message);
      socket.addEventListener('close', closed);
      try {
        socket.send(wire);
        submitted?.();
      } catch {
        finish(false);
      }
    });
  }
  private async clearConnected() {
    for (const id of this.owned.keys()) {
      if (!(await this.send(id, ''))) return;
      this.owned.delete(id);
    }
  }
  async close() {
    this.stopped = true;
    // Wait for an in-flight request before clearing the same socket.
    while (this.busy) await new Promise((resolve) => setTimeout(resolve, 10));
    await this.clearConnected();
    this.socket?.close();
    this.socket = null;
  }
}
