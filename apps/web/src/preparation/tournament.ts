import { useCallback, useEffect, useRef, useState } from 'react';
import type { LocalTournamentView } from '../workspace/LocalTournamentEditor';
const reasons: Record<string, string> = {
  invalid_json: '资料文件不完整或 JSON 格式损坏。',
  invalid_store: '资料结构或引用未通过校验。',
  too_large: '资料文件超过可安全恢复的容量。',
  EACCES: '没有读取资料文件的权限。',
  EPERM: '系统拒绝访问资料文件。',
  EISDIR: '资料文件位置被文件夹占用。',
  ENOENT: '先前的资料文件已缺失。',
};
export function useLocalTournament() {
  const [read, setRead] = useState<{
    view: LocalTournamentView | null;
    status: 'loading' | 'ready' | 'stale' | 'error';
    unavailable: boolean;
    error: string | null;
  }>({ view: null, status: 'loading', unavailable: false, error: null });
  const [reloading, setReloading] = useState(false);
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    const request = ++generation.current;
    try {
      const response = await fetch('/local/v1/tournament', {
        cache: 'no-store',
        signal: AbortSignal.timeout(2000),
      });
      if (!response.ok) {
        const failure = (await response.json().catch(() => null)) as {
          error?: string;
          reason?: string;
        } | null;
        if (failure?.error === 'local_tournament_unavailable') {
          if (request === generation.current)
            setRead((current) => ({
              ...current,
              status: current.view ? 'stale' : 'error',
              unavailable: true,
              error: `${reasons[failure.reason ?? ''] ?? '无法读取本地赛事资料。'}原文件已保留，请修复文件或权限后重新加载。`,
            }));
          return;
        }
        throw new Error('tournament_unavailable');
      }
      const view = (await response.json()) as LocalTournamentView;
      if (request === generation.current)
        setRead({ view, status: 'ready', unavailable: false, error: null });
    } catch {
      if (request === generation.current)
        setRead((current) => ({
          ...current,
          status: current.view ? 'stale' : 'error',
          error: current.unavailable
            ? current.error
            : '比赛库连接失败，保留最近资料与草稿；连接恢复前暂停编辑。',
        }));
    }
  }, []);
  const reload = useCallback(async () => {
    setReloading(true);
    generation.current++;
    try {
      await fetch('/operator/local-tournament/reload', {
        method: 'POST',
        signal: AbortSignal.timeout(10000),
      });
    } catch {
      // The following read retains the last view and reports the current connection state.
    } finally {
      await refresh();
      setReloading(false);
    }
  }, [refresh]);
  useEffect(() => {
    const requests = generation;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      await refresh();
      if (active) timer = setTimeout(() => void poll(), 3000);
    };
    void poll();
    return () => {
      active = false;
      requests.current++;
      clearTimeout(timer);
    };
  }, [refresh]);
  return { ...read, refresh, reload, reloading };
}
