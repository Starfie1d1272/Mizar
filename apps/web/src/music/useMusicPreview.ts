import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  MusicConfig,
  MusicGroup,
  MusicPreviewRequest,
  MusicPreviewStatus,
  MusicTrack,
} from '@mizar/protocol/music';

interface PreviewWork {
  request: MusicPreviewRequest;
  action: MusicPreviewRequest['action'];
  expires: number;
  resolve: () => void;
  reject: (error: unknown) => void;
}

export function useMusicPreview(active = true) {
  const [owner] = useState(() => crypto.randomUUID());
  const operation = useRef(0);
  const queue = useRef(new Map<MusicPreviewRequest['action'], PreviewWork>());
  const running = useRef(false);
  const worker = useRef(0);
  const abort = useRef<AbortController | null>(null);
  const intent = useRef(0);
  const responseOperation = useRef(0);
  const request = useRef<MusicPreviewRequest | null>(null);
  const [status, setStatus] = useState<MusicPreviewStatus | null>(null);
  const [error, setError] = useState('');
  const mounted = useRef(true);
  const send = useCallback(
    (r: MusicPreviewRequest, action: MusicPreviewRequest['action'], keepalive = false) => {
      const execute = async (work: PreviewWork, controller?: AbortController) => {
        const body = {
          ...work.request,
          action: work.action,
          operation: ++operation.current,
          expiresAt: Date.now() + 4000,
        };
        const response = await fetch('/operator/music/preview', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          keepalive: work.action === 'stop' && keepalive,
          ...(controller
            ? { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]) }
            : {}),
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
          request.current?.token === work.request.token &&
          body.operation > responseOperation.current
        ) {
          responseOperation.current = body.operation;
          const preview = result.status?.preview;
          if (preview?.token === work.request.token) {
            setStatus(preview);
            if (preview.phase === 'failed' || preview.phase === 'stopped') request.current = null;
          }
        }
      };
      return new Promise<void>((resolve, reject) => {
        const work: PreviewWork = {
          request: r,
          action,
          expires: Date.now() + 4000,
          resolve,
          reject,
        };
        if (action === 'stop') {
          // Cancel queued intent and bypass the active request. A higher operation also fences
          // any request that reaches the server after its transport was aborted.
          worker.current++;
          abort.current?.abort();
          abort.current = null;
          running.current = false;
          for (const pending of queue.current.values()) pending.resolve();
          queue.current.clear();
          void execute(work).then(resolve, reject);
          return;
        }
        if (request.current?.token !== r.token) {
          resolve();
          return;
        }
        queue.current.get(action)?.resolve(); // A superseded update/lease has no remaining work.
        queue.current.set(action, work);
        const pump = () => {
          if (running.current) return;
          running.current = true;
          const generation = ++worker.current;
          void (async () => {
            while (generation === worker.current) {
              // Volume updates also renew the server lease; prioritize the latest audible value.
              const next =
                queue.current.get('start') ??
                queue.current.get('update') ??
                queue.current.get('lease');
              if (!next) return;
              queue.current.delete(next.action);
              if (request.current?.token !== next.request.token || Date.now() >= next.expires) {
                next.resolve();
                continue;
              }
              const controller = new AbortController();
              abort.current = controller;
              try {
                await execute(next, controller);
                next.resolve();
              } catch (error) {
                next.reject(error);
              } finally {
                if (abort.current === controller) abort.current = null;
              }
            }
          })().finally(() => {
            if (generation === worker.current) {
              running.current = false;
              if (queue.current.size) pump();
            }
          });
        };
        pump();
      });
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
  useEffect(() => {
    if (active) return;
    intent.current++;
    const current = request.current;
    request.current = null;
    queueMicrotask(() => {
      if (mounted.current && request.current === null) setStatus(null);
    });
    if (current)
      void send(current, 'stop', true).catch(() => {
        if (mounted.current)
          setError('停止未确认，请在 OBS 检查 Mizar 音效来源；服务端将尝试清理。');
      });
  }, [active, send]);
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
    void send(request.current, 'update').catch(() => {
      if (mounted.current && request.current?.token === r.token)
        setError('试听音量更新未确认，请检查 OBS。');
    });
  };
  const stop = async () => {
    intent.current++;
    await stopCurrent();
  };
  return { status, error, start, stop, confirm, volume };
}
