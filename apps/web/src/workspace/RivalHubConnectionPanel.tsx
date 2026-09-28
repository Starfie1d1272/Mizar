import { useCallback, useEffect, useRef, useState } from 'react';

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

export function RivalHubConnectionPanel({
  action,
  onMessage,
}: {
  action: (run: () => Promise<unknown>) => Promise<void>;
  onMessage: (message: string) => void;
}) {
  const [connection, setConnection] = useState<Connection | null>(null);
  const [schedule, setSchedule] = useState<Schedule | null>(null);
  const [baseUrl, setBaseUrl] = useState('');
  const [code, setCode] = useState('');
  const [displayName, setDisplayName] = useState('');
  const autoClaimed = useRef<string | null>(null);
  const refresh = useCallback(async () => {
    const response = await fetch('/local/v1/rivalhub-connection', { cache: 'no-store' });
    if (!response.ok) return;
    const next = (await response.json()) as Connection;
    setConnection(next);
    if (next.paired) {
      const scheduleResponse = await fetch('/local/v1/rivalhub-schedule', { cache: 'no-store' });
      if (scheduleResponse.ok) setSchedule((await scheduleResponse.json()) as Schedule);
    }
  }, []);
  useEffect(() => {
    const initial = setTimeout(() => void refresh(), 0);
    const timer = setInterval(() => void refresh(), 10_000);
    return () => {
      clearTimeout(initial);
      clearInterval(timer);
    };
  }, [refresh]);
  useEffect(() => {
    const matchId = connection?.activeMatchId;
    if (!matchId || connection?.activeSourceMatchId === matchId || autoClaimed.current === matchId)
      return;
    autoClaimed.current = matchId;
    void fetch('/operator/rivalhub/source/claim', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }).then(() => refresh());
  }, [connection?.activeMatchId, connection?.activeSourceMatchId, refresh]);
  const command = async (path: string, body?: unknown) => {
    const response = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
    if (!response.ok) {
      const value = (await response.json().catch(() => null)) as { message?: string } | null;
      throw new Error(value?.message ?? '操作未完成。');
    }
    await refresh();
  };
  return (
    <div className="workspace-rivalhub" aria-label="RivalHub 赛事连接">
      <strong>RivalHub 赛事连接</strong>
      {!connection?.paired ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void action(async () => {
              await command('/operator/rivalhub/pair', {
                baseUrl: baseUrl.trim(),
                code: code.trim(),
                displayName: displayName.trim(),
              });
              setCode('');
              onMessage('赛事连接已建立。');
            });
          }}
        >
          <label>
            赛事网站地址{' '}
            <input
              type="url"
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
              placeholder="https://赛事网站"
              required
            />
          </label>
          <label>
            设备名称{' '}
            <input
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              placeholder="例如：主舞台制播机"
              required
            />
          </label>
          <label>
            一次性连接码{' '}
            <input
              value={code}
              onChange={(event) => setCode(event.target.value)}
              maxLength={22}
              required
            />
          </label>
          <button>连接 RivalHub</button>
        </form>
      ) : (
        <>
          <p>
            {schedule?.competition.name ?? '已连接赛事'} · {connection.displayName}
          </p>
          {schedule?.matches.length ? (
            <label>
              选择比赛{' '}
              <select
                defaultValue=""
                onChange={(event) => {
                  if (!event.target.value) return;
                  void action(async () => {
                    await command('/operator/rivalhub/select', { matchId: event.target.value });
                    onMessage('已取得比赛资料，请核对双方后确认加载。');
                  });
                }}
              >
                <option value="">查看近期赛程</option>
                {schedule.matches.map((match) => (
                  <option key={match.matchId} value={match.matchId}>
                    {match.scheduledAt
                      ? new Date(match.scheduledAt).toLocaleString('zh-CN')
                      : '待排期'}{' '}
                    · {match.entrantA.name} vs {match.entrantB.name} · {match.format.toUpperCase()}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <p>近期暂无比赛</p>
          )}
          {connection.activeMatchId && (
            <div className="workspace-rivalhub-source">
              <small>本场实时数据源</small>
              {connection.activeSourceMatchId === connection.activeMatchId ? (
                <>
                  <p>本机正在提供实时数据</p>
                  <button
                    onClick={() => void action(() => command('/operator/rivalhub/source/release'))}
                  >
                    停止作为数据源
                  </button>
                </>
              ) : (
                <>
                  <p>
                    {connection.activeDeviceName
                      ? `当前由 ${connection.activeDeviceName} 提供实时数据`
                      : '本机尚未提供实时数据'}
                  </p>
                  <button
                    onClick={() =>
                      void action(() =>
                        command('/operator/rivalhub/source/claim', {
                          takeover: Boolean(connection.activeDeviceName),
                        }),
                      )
                    }
                  >
                    成为本场数据源
                  </button>
                </>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
