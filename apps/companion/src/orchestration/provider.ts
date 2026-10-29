import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import {
  MulnxEventSequence,
  parseMulnxClock,
  type MulnxClockSample,
  type MulnxEventCandidate,
} from './mulnx-events.js';
export type GatewayResult = 'queued' | 'rejected' | 'unknown';
type CameraCommand =
  | 'CamMacro/Play'
  | 'CamPack/Apply'
  | 'CamPack/Status'
  | 'CamPlay/ClearForce'
  | 'System/Stop'
  | 'CS2BootLoader/Launch';
/** Fixed audited gateway. No arbitrary commands, endpoint, reconnect, retries or offline queue. */
export class MulnxProvider {
  private socket: WebSocket | null = null;
  private pending: { wire: string; finish: (result: GatewayResult) => void } | null = null;
  private readonly observers = new Set<(message: MulnxInput) => void>();
  generation = 0;
  constructor(private readonly diagnostic: (stage: string, evidence: unknown) => void = () => {}) {}
  get connected() {
    return this.socket?.readyState === WebSocket.OPEN;
  }
  subscribeInput(observer: (message: MulnxInput) => void): () => void {
    this.observers.add(observer);
    return () => this.observers.delete(observer);
  }
  private emitInput(message: MulnxInput): void {
    for (const observer of this.observers) {
      try {
        observer(message);
      } catch {
        /* Consumers cannot interrupt the socket. */
      }
    }
  }
  async connect(port = 55202): Promise<void> {
    this.close();
    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
    this.socket = socket;
    const generation = this.generation;
    const events = new MulnxEventSequence();
    let subscribed = false;
    socket.addEventListener('message', ({ data }) => {
      if (typeof data !== 'string' || this.socket !== socket) return;
      if (data.length > 64 * 1024) {
        this.close();
        return;
      }
      const text = data;
      if (text.startsWith('{')) {
        try {
          const raw: unknown = JSON.parse(text);
          if (raw && typeof raw === 'object' && 'type' in raw && raw.type === 'HSI/Subscribed') {
            if (!subscribed) {
              subscribed = true;
              this.emitInput({ kind: 'subscribed', generation });
            }
          } else if (subscribed) {
            const receivedMonotonicMs = performance.now();
            const clock = parseMulnxClock(raw, receivedMonotonicMs);
            if (clock) this.emitInput({ kind: 'clock', generation, sample: clock });
            else {
              const event = events.accept(raw);
              if (event) this.emitInput({ kind: 'event', generation, receivedMonotonicMs, event });
            }
          }
        } catch {
          /* Other frames are not HSI input. */
        }
      }
      if (!this.pending) return;
      const { wire, finish } = this.pending;
      // HSI broadcasts and unrelated / late replies are not execution evidence.
      if (text === `已投入消息总线${wire}`) finish('queued');
      else if (text.startsWith(`error: ${wire} desc: `)) finish('rejected');
    });
    socket.addEventListener('close', () => {
      if (this.socket === socket) this.close();
    });
    socket.addEventListener('error', (error) => {
      this.diagnostic('camera_transport', { result: 'failure', error });
      if (this.socket === socket) this.close();
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.socket === socket) this.close();
        reject(new Error('camera_connect_timeout'));
      }, 1500);
      socket.addEventListener(
        'open',
        () => {
          clearTimeout(timer);
          if (generation === this.generation) {
            try {
              socket.send(JSON.stringify({ type: 'HSI/Subscribe' }));
            } catch {
              /* Camera connection remains independent. */
            }
            resolve();
          } else reject(new Error('camera_cancelled'));
        },
        { once: true },
      );
      socket.addEventListener(
        'error',
        () => {
          clearTimeout(timer);
          reject(new Error('camera_connect_failed'));
        },
        { once: true },
      );
      socket.addEventListener(
        'close',
        () => {
          clearTimeout(timer);
          reject(new Error('camera_disconnected'));
        },
        { once: true },
      );
    });
    this.diagnostic('camera_connect', { result: 'connected', generation });
  }
  send(type: CameraCommand, value = ''): Promise<GatewayResult> {
    if (!this.connected) return Promise.resolve('unknown');
    if (this.pending) {
      if (type !== 'CamPlay/ClearForce' && type !== 'System/Stop')
        return Promise.resolve('unknown');
      this.pending.finish('unknown'); // Stop preempts a request; never waits behind playback.
    }
    const wire = JSON.stringify({
      type,
      payload:
        type === 'CamMacro/Play' || type === 'CamPack/Apply' || type === 'CamPack/Status'
          ? JSON.stringify(value)
          : '',
    });
    const socket = this.socket!;
    this.diagnostic('camera_request', { wire, generation: this.generation, result: 'submitted' });
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        finish('unknown');
        if (this.socket === socket) this.close();
      }, 1500);
      const finish = (result: GatewayResult) => {
        if (this.pending?.finish !== finish) return;
        clearTimeout(timer);
        this.pending = null;
        this.diagnostic('camera_gateway', {
          wire,
          generation: this.generation,
          result,
          execution: 'unconfirmed',
        });
        resolve(result);
      };
      this.pending = { wire, finish };
      try {
        socket.send(wire);
      } catch (error) {
        this.diagnostic('camera_transport', { result: 'failure', error });
        finish('unknown');
        if (this.socket === socket) this.close();
      }
    });
  }
  async packStatus(): Promise<{ active: string | null; empty: boolean } | null> {
    const socket = this.socket;
    if (!socket || !this.connected || this.pending) return null;
    const requestId = randomUUID();
    const generation = this.generation;
    let finish!: (status: { active: string | null; empty: boolean } | null) => void;
    const response = new Promise<{ active: string | null; empty: boolean } | null>((resolve) => {
      const timer = setTimeout(() => finish(null), 1500);
      const listener = ({ data }: MessageEvent) => {
        if (typeof data !== 'string' || data.length > 64 * 1024) return;
        try {
          const value: unknown = JSON.parse(data);
          if (!value || typeof value !== 'object' || Array.isArray(value)) return;
          const status = value as Record<string, unknown>;
          if (status.type !== 'CamPack/Status' || status.requestId !== requestId) return;
          if (status.active === null) return finish({ active: null, empty: false });
          if (
            typeof status.active !== 'string' ||
            !['OnNewRoundEmpty', 'OnRoundStartEmpty', 'OnRoundEndEmpty'].every(
              (key) => typeof status[key] === 'boolean',
            )
          )
            return finish(null);
          finish({
            active: status.active,
            empty:
              status.OnNewRoundEmpty === true &&
              status.OnRoundStartEmpty === true &&
              status.OnRoundEndEmpty === true,
          });
        } catch {
          /* unrelated messages */
        }
      };
      finish = (status) => {
        clearTimeout(timer);
        socket.removeEventListener('message', listener);
        resolve(status);
      };
      socket.addEventListener('message', listener);
    });
    const ack = await this.send('CamPack/Status', requestId);
    if (ack !== 'queued') finish(null);
    const status = await response;
    return ack === 'queued' && this.socket === socket && this.generation === generation
      ? status
      : null;
  }
  /** Upstream #9 only acknowledges queueing. Never retry or infer unload from disconnect. */
  async stopControl(): Promise<GatewayResult> {
    try {
      return await this.send('System/Stop');
    } finally {
      this.close();
    }
  }
  close() {
    this.pending?.finish('unknown');
    const socket = this.socket;
    this.socket = null;
    this.generation++;
    if (socket) this.emitInput({ kind: 'disconnected', generation: this.generation });
    socket?.close();
  }
}

export type MulnxInput =
  | { readonly kind: 'subscribed'; readonly generation: number }
  | { readonly kind: 'clock'; readonly generation: number; readonly sample: MulnxClockSample }
  | {
      readonly kind: 'event';
      readonly generation: number;
      readonly receivedMonotonicMs: number;
      readonly event: MulnxEventCandidate;
    }
  | { readonly kind: 'disconnected'; readonly generation: number };

// Native-only fixed operation; no browser-provided commands or endpoints.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const action = process.argv.slice(2).join(' ');
  if (action !== '--stop-mulnx' && action !== '--launch-mulnx') throw new Error('mulnx_arguments');
  const provider = new MulnxProvider();
  try {
    await provider.connect(action === '--launch-mulnx' ? 55203 : 55202);
    const result =
      action === '--launch-mulnx'
        ? await provider.send('CS2BootLoader/Launch')
        : await provider.stopControl();
    console.log(JSON.stringify({ result, execution: 'unconfirmed' }));
  } finally {
    provider.close();
  }
}
