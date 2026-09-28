import { useState } from 'react';
import { Button, Field, Panel, Select, StatusBanner } from '../ui';
import { command, useLocalRead } from './client';
export interface RosterCandidate {
  revision: string;
  contextRevision: string;
  sourceGeneration: number;
  mapEpoch: number;
  ctName: string | null;
  tName: string | null;
  ctEntrant: 'a' | 'b' | null;
  ct: { steam64: string; displayName: string | null }[];
  t: { steam64: string; displayName: string | null }[];
}
export function RosterCapture({
  create = false,
  autoOpen = false,
  names,
  onSaved,
}: {
  create?: boolean;
  autoOpen?: boolean;
  names?: { a: string; b: string };
  onSaved?: () => void;
}) {
  const result = useLocalRead<{ candidate: RosterCandidate | null; local: boolean }>(
    '/local/v1/roster-candidate',
  );
  const [shown, setShown] = useState(false);
  const [autoDismissed, setAutoDismissed] = useState(false);
  const [selectedCandidate, setSelectedCandidate] = useState<RosterCandidate | null>(null);
  const [ctEntrant, setCtEntrant] = useState('');
  const [a, setA] = useState('');
  const [b, setB] = useState('');
  const [format, setFormat] = useState('bo3');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const autoCandidate = autoOpen && !autoDismissed ? result?.candidate : null;
  const candidate = selectedCandidate ?? autoCandidate ?? null;
  const isShown = shown || Boolean(autoCandidate);
  if (create && !candidate && !shown) return null;
  return (
    <Panel className="preparation-capture">
      <Button
        disabled={!result?.candidate || busy || (!create && !result.local)}
        onClick={() => {
          setSelectedCandidate(result?.candidate ?? null);
          setCtEntrant('');
          setShown(true);
          setMessage('');
        }}
      >
        {create ? '从当前服务器创建比赛' : '从当前服务器识别首发'}
      </Button>
      {!result?.candidate && !create ? <p>等待当前服务器提供完整、可信的 5v5 名单。</p> : null}
      {isShown && candidate ? (
        <>
          <div className="preparation-columns">
            {(['ct', 't'] as const).map((side) => (
              <section key={side}>
                <h3>
                  {side.toUpperCase()} ·{' '}
                  {side === 'ct'
                    ? (candidate.ctName ?? '待命名队伍')
                    : (candidate.tName ?? '待命名队伍')}
                </h3>
                <ul>
                  {candidate[side].map((player) => (
                    <li key={player.steam64}>{player.displayName ?? player.steam64}</li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
          {create ? (
            <>
              {!candidate.ctName ? (
                <Field label="CT 队伍名称" value={a} onChange={(e) => setA(e.target.value)} />
              ) : null}
              {!candidate.tName ? (
                <Field label="T 队伍名称" value={b} onChange={(e) => setB(e.target.value)} />
              ) : null}
              <Select label="赛制" value={format} onChange={(e) => setFormat(e.target.value)}>
                {['bo1', 'bo3', 'bo5'].map((bo) => (
                  <option key={bo} value={bo}>
                    {bo.toUpperCase()}
                  </option>
                ))}
              </Select>
            </>
          ) : !candidate.ctEntrant ? (
            <Select
              label="当前 CT 是"
              value={ctEntrant}
              onChange={(e) => setCtEntrant(e.target.value)}
            >
              <option value="">请选择队伍</option>
              <option value="a">{names?.a}</option>
              <option value="b">{names?.b}</option>
            </Select>
          ) : (
            <p>已匹配当前 CT：{names?.[candidate.ctEntrant]}</p>
          )}
          {candidate.revision !== result?.candidate?.revision ? (
            <StatusBanner tone="warning">服务器名单已变化，请重新识别。</StatusBanner>
          ) : null}
          <Button
            variant="primary"
            loading={busy}
            disabled={
              candidate.revision !== result?.candidate?.revision ||
              (!create && !candidate.ctEntrant && !ctEntrant) ||
              (create && ((!candidate.ctName && !a.trim()) || (!candidate.tName && !b.trim())))
            }
            onClick={() => {
              setBusy(true);
              void command(`/operator/local-match/${create ? 'create-from-server' : 'capture'}`, {
                candidateRevision: candidate.revision,
                expectedContextRevision: candidate.contextRevision,
                expectedSourceGeneration: candidate.sourceGeneration,
                expectedMapEpoch: candidate.mapEpoch,
                ctEntrant,
                teamA: a,
                teamB: b,
                format,
              })
                .then(() => {
                  setShown(false);
                  setAutoDismissed(true);
                  setMessage('名单已保存。');
                  onSaved?.();
                })
                .catch((error: Error) => setMessage(error.message))
                .finally(() => setBusy(false));
            }}
          >
            {create ? '创建本地比赛' : '确认保存首发'}
          </Button>
        </>
      ) : null}
      {message ? <StatusBanner tone="info">{message}</StatusBanner> : null}
    </Panel>
  );
}
