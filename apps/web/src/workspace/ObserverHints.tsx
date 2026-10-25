import { useSyncExternalStore } from 'react';
import { useLocalChannelClient } from '../realtime';
import { StatusPill } from '../ui';
import { observerHotkeyLabel } from '../program/observer-hotkey';

export function ObserverHints() {
  const client = useLocalChannelClient('assist');
  const state = useSyncExternalStore(client.subscribe, client.getSnapshot, client.getSnapshot);
  const observer = state.state === 'live' ? state.current?.payload.observer : undefined;
  if (!observer || (observer.state === 'ready' && observer.hints.length === 0)) return null;
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
      {observer.hints.length ? (
        <ol className="observer-hints">
          {observer.hints.map((hint) => (
            <li key={hint.id} data-occurred={hint.occurred}>
              <span className="observer-hints__time">
                {hint.occurred ? '已发生' : `${hint.remainingSeconds.toFixed(1)} 秒后`}
              </span>
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
