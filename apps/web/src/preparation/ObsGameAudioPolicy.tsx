import { useEffect, useRef, useState } from 'react';
import { obsGameAudioPolicySchema } from '@mizar/protocol/obs';
import { Button, Field, Select } from '../ui';
type Policy = { mode: 'keep' | 'mute' } | { mode: 'attenuate'; db: number };
type Status = {
  ready: boolean;
  desktopMix?: boolean;
  revision: string;
  policy: Policy;
  ownership: 'idle' | 'intent' | 'owned' | 'held';
};
function readStatus(value: unknown): Status {
  const next = value as Status | null;
  if (
    !next ||
    typeof next.ready !== 'boolean' ||
    typeof next.revision !== 'string' ||
    !['idle', 'intent', 'owned', 'held'].includes(next.ownership) ||
    !obsGameAudioPolicySchema.safeParse(next.policy).success
  )
    throw new Error('无法读取中场音频设置。');
  return next;
}
export function ObsGameAudioPolicy() {
  const [status, setStatus] = useState<Status | null>(null);
  const [draftRevision, setDraftRevision] = useState('');
  const [mode, setMode] = useState<Policy['mode']>('keep');
  const [db, setDb] = useState(6);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const pollSequence = useRef(0);
  const inFlight = useRef(false);
  const confirmedRevision = useRef('');
  const initialized = useRef(false);
  async function refresh(requestGeneration: number, sequence: number) {
    const response = await fetch('/local/v1/obs/game-audio-policy', { cache: 'no-store' });
    if (!response.ok) throw new Error('无法读取中场音频设置。');
    const next = readStatus(await response.json());
    if (requestGeneration !== generation.current || sequence !== pollSequence.current) return next;
    setStatus(next);
    if (next.ready) {
      initialized.current = true;
      setDraftRevision(next.revision);
      setMode(next.policy.mode);
      if (next.policy.mode === 'attenuate') setDb(next.policy.db);
    }
    return next;
  }
  useEffect(() => {
    const generationRef = generation;
    const initialGeneration = generationRef.current;
    const initialSequence = ++pollSequence.current;
    void Promise.resolve()
      .then(() => refresh(initialGeneration, initialSequence))
      .catch(() => {
        if (initialGeneration === generationRef.current && initialSequence === pollSequence.current)
          setMessage({ text: '无法读取中场音频设置。', error: true });
      });
    const timer = setInterval(() => {
      if (inFlight.current) return;
      const requestGeneration = generationRef.current;
      const sequence = ++pollSequence.current;
      void fetch('/local/v1/obs/game-audio-policy', { cache: 'no-store' })
        .then((response) => (response.ok ? response.json() : null))
        .then((value: unknown) => (value ? readStatus(value) : null))
        .then((next: Status | null) => {
          if (
            next &&
            requestGeneration === generationRef.current &&
            sequence === pollSequence.current
          ) {
            setStatus(next);
            if (next.ready && !initialized.current) {
              initialized.current = true;
              setDraftRevision(next.revision);
              setMode(next.policy.mode);
              if (next.policy.mode === 'attenuate') setDb(next.policy.db);
            }
            if (confirmedRevision.current && next.revision !== confirmedRevision.current) {
              confirmedRevision.current = '';
              setMessage(null);
            }
          }
        })
        .catch(() => undefined);
    }, 2000);
    return () => {
      generationRef.current++;
      clearInterval(timer);
    };
  }, []);
  async function send(path: string, body: unknown, expected?: Policy) {
    if (inFlight.current) return;
    inFlight.current = true;
    const requestGeneration = ++generation.current;
    setBusy(true);
    setMessage(null);
    try {
      let response: Response;
      try {
        response = await fetch(path, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      } catch {
        throw new Error('操作结果无法确认，请重新读取设置并核对。');
      }
      if (!response.ok) {
        await refresh(requestGeneration, ++pollSequence.current).catch(() => undefined);
        throw new Error('操作未确认，请核对设置后重试。');
      }
      const next = await refresh(requestGeneration, ++pollSequence.current).catch(() => {
        throw new Error('操作已提交，但无法读取结果，请重新核对设置。');
      });
      if (expected) {
        if (
          !next.ready ||
          next.policy.mode !== expected.mode ||
          (expected.mode === 'attenuate' &&
            (next.policy.mode !== 'attenuate' || next.policy.db !== expected.db))
        )
          throw new Error('保存后的策略与所选设置不一致，请重新核对。');
        confirmedRevision.current = next.revision;
        setMessage({ text: '中场策略已保存。', error: false });
      }
    } catch (error) {
      setMessage({ text: error instanceof Error ? error.message : '操作未完成。', error: true });
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  return (
    <div className="game-audio-policy">
      <h3>中场游戏音频</h3>
      {status?.desktopMix && (
        <p>桌面混音无法单独控制游戏；中场游戏音频策略暂停，切回独立分路后恢复。</p>
      )}
      <p>
        只调整已绑定的游戏来源，不调整解说和麦克风来源。默认保持游戏音量不变；请在 OBS
        核对实际声音。
      </p>
      <p>
        比赛恢复时，系统会尝试恢复中场前的游戏音量或静音状态。中场期间人工调整或连接状态无法确认时，系统会停止自动控制，保留当前状态并提示处理。
      </p>
      <Select
        label="中场策略"
        value={mode}
        disabled={busy || !status?.ready || status.desktopMix}
        onChange={(e) => {
          setMessage(null);
          setMode(e.target.value as Policy['mode']);
        }}
      >
        <option value="keep">保持游戏音量</option>
        <option value="attenuate">降低游戏音量</option>
        <option value="mute">静音游戏</option>
      </Select>
      {mode === 'attenuate' && (
        <Field
          label="降低音量（dB）"
          type="number"
          min="0.1"
          max="60"
          step="0.1"
          value={db}
          disabled={busy || !status?.ready || status.desktopMix}
          onChange={(e) => {
            setMessage(null);
            setDb(Number(e.target.value));
          }}
        />
      )}
      <Button
        disabled={
          busy ||
          !status?.ready ||
          status.desktopMix ||
          (mode === 'attenuate' && !(db > 0 && db <= 60))
        }
        onClick={() =>
          void send(
            '/operator/obs/game-audio-policy',
            {
              revision: draftRevision,
              policy: mode === 'attenuate' ? { mode, db } : { mode },
            },
            mode === 'attenuate' ? { mode, db } : { mode },
          )
        }
      >
        保存中场策略
      </Button>
      {status?.ownership === 'held' && (
        <p role="status">
          游戏音频的自动控制已暂停。请在比赛恢复后先在 OBS 手动恢复游戏音量与静音状态，然后{' '}
          <Button
            disabled={busy}
            onClick={() =>
              void send('/operator/obs/game-audio-release', { revision: status.revision })
            }
          >
            恢复自动控制
          </Button>
          。
        </p>
      )}
      {message && <p role={message.error ? 'alert' : 'status'}>{message.text}</p>}
    </div>
  );
}
