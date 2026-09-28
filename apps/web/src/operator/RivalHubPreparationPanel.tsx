import { useCallback, useEffect, useState } from 'react';
import { switchToRivalhubBp, useBpWorkspace } from '../bp/client';
import { Button, Panel, Select, StatusBanner, StatusPill } from '../ui/primitives';
import { openRivalHubAuthorization } from '../preparation/client';

type Connection = {
  paired: boolean;
  displayName: string | null;
  activeMatchId: string | null;
  activeSourceMatchId: string | null;
  activeDeviceName: string | null;
};

type Schedule = {
  competition: { name: string };
  matches: {
    matchId: string;
    scheduledAt: string | null;
    entrantA: { name: string };
    entrantB: { name: string };
    format: string;
    stageLabel?: string | null;
  }[];
};

export function RivalHubPreparationPanel({ mode = 'matches' }: { mode?: 'matches' | 'settings' }) {
  const [connection, setConnection] = useState<Connection | null>(null);
  const [schedule, setSchedule] = useState<Schedule | null>(null);
  const [pairing, setPairing] = useState(false);
  const [pairingStarting, setPairingStarting] = useState(false);
  const [authorizeUrl, setAuthorizeUrl] = useState<string | null>(null);
  const [rePairing, setRePairing] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { workspace: bpWorkspace } = useBpWorkspace();

  const refresh = useCallback(async () => {
    try {
      const response = await fetch('/local/v1/rivalhub-connection', { cache: 'no-store' });
      if (!response.ok) return;
      const next = (await response.json()) as Connection;
      setConnection(next);
      if (next.paired) {
        const scheduleResponse = await fetch('/local/v1/rivalhub-schedule', { cache: 'no-store' });
        if (scheduleResponse.ok) {
          setSchedule((await scheduleResponse.json()) as Schedule);
        }
      }
    } catch {
      // Background poll failure is quiet
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const response = await fetch('/local/v1/rivalhub-connection', { cache: 'no-store' });
        if (!response.ok || cancelled) return;
        const next = (await response.json()) as Connection;
        if (cancelled) return;
        setConnection(next);
        if (next.paired) {
          const scheduleResponse = await fetch('/local/v1/rivalhub-schedule', {
            cache: 'no-store',
          });
          if (scheduleResponse.ok && !cancelled) {
            setSchedule((await scheduleResponse.json()) as Schedule);
          }
        }
      } catch {
        // Quiet
      }
    }
    void load();
    const interval = setInterval(() => void load(), 10_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    if (!pairing) return;
    let active = true;
    const poll = async () => {
      try {
        const response = await fetch('/operator/rivalhub/pairing/poll', { method: 'POST' });
        if (!response.ok) return;
        const result = (await response.json()) as { status: string };
        if (!active) return;
        if (result.status === 'authorized') {
          setPairing(false);
          setRePairing(false);
          setAuthorizeUrl(null);
          setMessage('RivalHub 已连接。');
          await refresh();
        } else if (result.status === 'expired' || result.status === 'idle') {
          setPairing(false);
          setAuthorizeUrl(null);
          setError('授权已过期，请重新连接。');
        }
      } catch {
        // A brief network interruption does not cancel an open authorization.
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 1000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [pairing, refresh]);

  async function handlePair() {
    const popup = window.__TAURI_INTERNALS__ ? null : window.open('', 'mizar-rivalhub');
    setPairingStarting(true);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch('/operator/rivalhub/pairing/start', { method: 'POST' });
      if (!response.ok) {
        const data = (await response.json().catch(() => null)) as { message?: string } | null;
        throw new Error(data?.message ?? '无法打开授权页面，请重试。');
      }
      const result = (await response.json()) as { authorizeUrl: string };
      await openRivalHubAuthorization(result.authorizeUrl, popup);
      setAuthorizeUrl(result.authorizeUrl);
      setPairing(true);
    } catch (err) {
      popup?.close();
      setError(err instanceof Error ? err.message : '连接未完成。');
    } finally {
      setPairingStarting(false);
    }
  }

  async function handleSelectMatch(matchId: string) {
    if (!matchId) return;
    setSelecting(true);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch('/operator/rivalhub/select', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ matchId }),
      });
      if (!response.ok) {
        const data = (await response.json().catch(() => null)) as { message?: string } | null;
        throw new Error(data?.message ?? '比赛选择未完成。');
      }
      setMessage('已取得比赛资料，请核对双方后确认加载。');
    } catch (err) {
      setError(err instanceof Error ? err.message : '选择比赛失败。');
    } finally {
      setSelecting(false);
    }
  }

  async function handleConfirmCandidate() {
    if (!bpWorkspace?.pendingRivalhub) return;
    setConfirming(true);
    setError(null);
    setMessage(null);
    try {
      await switchToRivalhubBp(bpWorkspace.contextRevision, bpWorkspace.pendingRivalhub.revision);
      setMessage('在线比赛已加载。进入现场工作区后会检查实时数据源；无人占用时自动认领。');
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : '确认在线比赛失败。');
    } finally {
      setConfirming(false);
    }
  }

  return (
    <Panel className="operator-rivalhub-panel" aria-label="RivalHub 赛事连接与准备">
      {!connection?.paired || (mode === 'settings' && rePairing) ? (
        mode === 'matches' ? (
          <Button
            onClick={() => {
              window.location.href = '/settings?tab=rivalhub';
            }}
          >
            连接 RivalHub
          </Button>
        ) : (
          <>
            <div className="operator-rivalhub-header">
              <div>
                <h2>连接 RivalHub 赛事</h2>
                <p>在 RivalHub 登录并确认授权，完成后会自动连接。</p>
              </div>
            </div>
            <div className="operator-rivalhub-form">
              <div>
                <Button
                  variant="primary"
                  loading={pairingStarting}
                  disabled={pairing || pairingStarting}
                  onClick={() => void handlePair()}
                >
                  连接 RivalHub
                </Button>
                {pairing && authorizeUrl ? (
                  <Button onClick={() => void openRivalHubAuthorization(authorizeUrl)}>
                    重新打开授权页面
                  </Button>
                ) : null}
                {connection?.paired ? (
                  <Button disabled={pairingStarting} onClick={() => setRePairing(false)}>
                    取消
                  </Button>
                ) : null}
              </div>
              {pairing ? <p role="status">正在等待 RivalHub 授权…</p> : null}
            </div>
          </>
        )
      ) : (
        <>
          <div className="operator-rivalhub-header">
            <div>
              <h2>{schedule?.competition?.name ?? '已连接赛事'}</h2>
              <p>
                {connection.displayName} · {schedule?.competition?.name ?? '赛事已连接'}
              </p>
            </div>
            <StatusPill tone="success">已连接</StatusPill>
          </div>

          {mode === 'settings' ? (
            <>
              <Button onClick={() => setRePairing(true)}>重新连接 / 更换赛事</Button>
              <Button
                onClick={() => {
                  void fetch('/operator/rivalhub/disconnect', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: '{}',
                  })
                    .then((response) => {
                      if (!response.ok) throw new Error('断开未完成，请重试。');
                      return refresh();
                    })
                    .catch((error: Error) => setError(error.message));
                }}
              >
                断开 RivalHub
              </Button>
            </>
          ) : null}
          {mode === 'matches' ? (
            <>
              {schedule?.matches && schedule.matches.length > 0 ? (
                <Select
                  label="选择比赛"
                  defaultValue=""
                  onChange={(e) => void handleSelectMatch(e.target.value)}
                  disabled={selecting}
                >
                  <option value="">查看近期赛程（请选择比赛）</option>
                  {schedule.matches.map((match) => (
                    <option key={match.matchId} value={match.matchId}>
                      {match.scheduledAt
                        ? new Date(match.scheduledAt).toLocaleString('zh-CN')
                        : '待排期'}{' '}
                      · {match.entrantA.name} vs {match.entrantB.name} ·{' '}
                      {match.format.toUpperCase()}
                    </option>
                  ))}
                </Select>
              ) : (
                <p className="operator-rivalhub-empty">近期暂无比赛</p>
              )}

              {bpWorkspace?.pendingRivalhub ? (
                <div className="operator-rivalhub-candidate">
                  <div className="operator-rivalhub-candidate-info">
                    <small>待确认比赛候选</small>
                    <strong>
                      {bpWorkspace.pendingRivalhub.entrants.a.name} vs{' '}
                      {bpWorkspace.pendingRivalhub.entrants.b.name}
                    </strong>
                    <span>
                      {bpWorkspace.pendingRivalhub.competition} ·{' '}
                      {bpWorkspace.pendingRivalhub.format.toUpperCase()}
                    </span>
                  </div>
                  <Button
                    variant="primary"
                    loading={confirming}
                    disabled={confirming}
                    onClick={() => void handleConfirmCandidate()}
                  >
                    确认加载比赛
                  </Button>
                </div>
              ) : null}
            </>
          ) : null}
        </>
      )}

      {error ? <StatusBanner tone="danger">{error}</StatusBanner> : null}
      {message ? <StatusBanner tone="info">{message}</StatusBanner> : null}
    </Panel>
  );
}
