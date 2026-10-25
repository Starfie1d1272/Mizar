import { fileURLToPath } from 'node:url';
export type GatewayResult = 'queued' | 'rejected' | 'unknown';
type CameraCommand = 'CamMacro/Play' | 'CamPlay/ClearForce' | 'System/Stop';
/** Fixed audited gateway. No arbitrary commands, endpoint, reconnect, retries or offline queue. */
export class MulnxProvider {
  private socket: WebSocket | null = null;
  private pending: { wire: string; finish: (result: GatewayResult) => void } | null = null;
  generation = 0;
  constructor(private readonly diagnostic: (stage: string, evidence: unknown) => void = () => {}) {}
  get connected() {
    return this.socket?.readyState === WebSocket.OPEN;
  }
  async connect(port = 55202): Promise<void> {
    this.close();
    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
    this.socket = socket;
    const generation = this.generation;
    socket.addEventListener('message', ({ data }) => {
      if (typeof data !== 'string' || this.socket !== socket || !this.pending) return;
      if (data.length > 64 * 1024) {
        this.close();
        return;
      }
      const text = data;
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
          if (generation === this.generation) resolve();
          else reject(new Error('camera_cancelled'));
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
  send(type: CameraCommand, macro = ''): Promise<GatewayResult> {
    if (!this.connected) return Promise.resolve('unknown');
    if (this.pending) {
      if (type !== 'CamPlay/ClearForce' && type !== 'System/Stop')
        return Promise.resolve('unknown');
      this.pending.finish('unknown'); // Stop preempts a request; never waits behind playback.
    }
    const wire = JSON.stringify({
      type,
      payload: type === 'CamMacro/Play' ? JSON.stringify(macro) : '',
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
    socket?.close();
  }
}

// Native-only fixed operation; no browser-provided commands or endpoints.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.slice(2).join(' ') !== '--stop-mulnx') throw new Error('mulnx_stop_arguments');
  const provider = new MulnxProvider();
  try {
    await provider.connect();
    console.log(JSON.stringify({ result: await provider.stopControl(), execution: 'unconfirmed' }));
  } finally {
    provider.close();
  }
}
