import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  MusicConfig,
  MusicGroup,
  MusicPreviewRequest,
  MusicPreviewStatus,
  MusicTrack,
} from '@mizar/protocol/music';

export function useMusicPreview() {
  const [owner] = useState(() => crypto.randomUUID());
  const operation = useRef(0);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const intent = useRef(0);
  const responseOperation = useRef(0);
  const request = useRef<MusicPreviewRequest | null>(null);
  const [status, setStatus] = useState<MusicPreviewStatus | null>(null);
  const [error, setError] = useState('');
  const mounted = useRef(true);
  const send = useCallback(
    async (r: MusicPreviewRequest, action: MusicPreviewRequest['action'], keepalive = false) => {
      const body = { ...r, action, operation: ++operation.current, expiresAt: Date.now() + 4000 };
      const run = async () => {
        const response = await fetch('/operator/music/preview', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          keepalive,
          ...(keepalive ? {} : { signal: AbortSignal.timeout(5000) }),
        });
        const result = (await response.json()) as {
          status?: { preview?: MusicPreviewStatus };
          message?: string;
          error?: string;
        };
        if (result.error === 'music_preview_stale_operation') return;
        if (!response.ok) throw new Error(result.message ?? '试听未完成，请检查本机服务与 OBS。');
        if (
          mounted.current &&
          request.current?.token === r.token &&
          body.operation > responseOperation.current
        ) {
          responseOperation.current = body.operation;
          const preview = result.status?.preview;
          if (preview?.token === r.token) {
            setStatus(preview);
            if (preview.phase === 'failed' || preview.phase === 'stopped') request.current = null;
          }
        }
      };
      // STOP bypasses queued work. Its newer operation also invalidates requests already in transit.
      if (action === 'stop') return run();
      const pending = queue.current.catch(() => undefined).then(run);
      queue.current = pending.catch(() => undefined);
      await pending;
    },
    [],
  );
  const stopCurrent = async () => {
    const r = request.current;
    if (!r) return;
    request.current = null;
    setStatus(null);
    try {
      await send(r, 'stop', true);
    } catch {
      if (mounted.current) setError('停止未确认，请在 OBS 检查 Mizar 音效来源；服务端将尝试清理。');
    }
  };
  useEffect(() => {
    mounted.current = true;
    const leave = () => {
      intent.current++;
      const r = request.current;
      request.current = null;
      if (r) void send(r, 'stop', true).catch(() => {});
    };
    const timer = setInterval(() => {
      const r = request.current;
      if (r)
        void send(r, 'lease').catch(() => {
          if (request.current?.token !== r.token) return;
          if (mounted.current) setError('试听连接中断，停止未确认。请在 OBS 检查 Mizar 音效来源。');
          request.current = null;
        });
    }, 1000);
    window.addEventListener('pagehide', leave);
    return () => {
      mounted.current = false;
      clearInterval(timer);
      window.removeEventListener('pagehide', leave);
      leave();
    };
    // The owner and operation counter belong to this mounted window, including its cleanup requests.
  }, [send]);
  const start = async (
    group: MusicGroup,
    spec: MusicConfig['groups'][MusicGroup],
    track: MusicTrack,
  ) => {
    const revision = ++intent.current;
    setError('');
    await stopCurrent();
    if (revision !== intent.current || !mounted.current) return;
    const r: MusicPreviewRequest = {
      owner,
      token: crypto.randomUUID(),
      operation: 1,
      expiresAt: 0,
      action: 'start',
      group,
      track,
      volume: spec.volume,
      fadeInMs: spec.fadeInMs,
      fadeOutMs: spec.fadeOutMs,
      confirmed: false,
    };
    request.current = r;
    setStatus({
      owner,
      token: r.token,
      group,
      phase: 'requested',
      message: '正在核对 OBS 试听状态…',
    });
    try {
      await send(r, 'start');
    } catch (e) {
      if (request.current?.token === r.token) {
        request.current = null;
        setStatus(null);
        setError(e instanceof Error ? e.message : '试听未完成。');
      }
    }
  };
  const confirm = async () => {
    const r = request.current;
    if (!r || r.confirmed) return;
    setStatus((previous) =>
      previous ? { ...previous, phase: 'requested', message: '正在核对 OBS 试听状态…' } : previous,
    );
    request.current = { ...r, confirmed: true };
    try {
      await send(request.current, 'start');
    } catch (e) {
      setError(e instanceof Error ? e.message : '试听未完成。');
    }
  };
  const volume = (group: MusicGroup, value: number) => {
    const r = request.current;
    if (!r || r.group !== group) return;
    request.current = { ...r, volume: value };
    void send(request.current, 'update').catch(() => setError('试听音量更新未确认，请检查 OBS。'));
  };
  const stop = async () => {
    intent.current++;
    await stopCurrent();
  };
  return { status, error, start, stop, confirm, volume };
}
