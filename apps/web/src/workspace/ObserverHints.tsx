import { useEffect, useState, useSyncExternalStore } from 'react';
import { useLocalChannelClient } from '../realtime';
import { StatusPill } from '../ui';
import { observerHotkeyLabel } from '../program/observer-hotkey';

export function ObserverHints() {
  const client = useLocalChannelClient('assist');
  const state = useSyncExternalStore(client.subscribe, client.getSnapshot, client.getSnapshot);
  const observer = state.state === 'live' ? state.current?.payload.observer : undefined;
  const [clock, setClock] = useState({ observer, elapsed: 0 });
  useEffect(() => {
    if (!observer?.hints.length) return;
    const receivedAt = performance.now();
    const timer = window.setInterval(() => {
      setClock({ observer, elapsed: (performance.now() - receivedAt) / 1000 });
    }, 100);
    return () => window.clearInterval(timer);
  }, [observer]);
  // Advance the received countdown locally so an event also expires between snapshots.
  const elapsed = clock.observer === observer ? clock.elapsed : 0;
  const hints =
    observer?.hints
      .map((hint) => ({ ...hint, remainingSeconds: hint.remainingSeconds - elapsed }))
      .filter((hint) => hint.remainingSeconds > 0) ?? [];
  if (!observer || (observer.state === 'ready' && hints.length === 0)) return null;
  const labels = {
    connecting: '连接早源',
    aligning: '正在对齐',
    paused: '比赛暂停',
    unavailable: '等待节目数据',
  };
  return (
    <section className="workspace-observer-assist" aria-label="私有观察辅助">
      {observer.state !== 'ready' ? (
        <StatusPill tone="info">{labels[observer.state]}</StatusPill>
      ) : null}
      {hints.length ? (
        <ol className="observer-hints">
          {hints.map((hint) => (
            <li key={hint.id}>
              <span className="observer-hints__time">{Math.ceil(hint.remainingSeconds)} 秒后</span>
              <span className="observer-hints__players">
                <kbd>{observerHotkeyLabel(hint.attacker.observerSlot)}</kbd>{' '}
                <strong title={hint.attacker.name}>{hint.attacker.name}</strong>
                <small>击杀</small>
                <kbd>{observerHotkeyLabel(hint.victim.observerSlot)}</kbd>{' '}
                <span title={hint.victim.name}>{hint.victim.name}</span>
              </span>
            </li>
          ))}
        </ol>
      ) : null}
    </section>
  );
}
