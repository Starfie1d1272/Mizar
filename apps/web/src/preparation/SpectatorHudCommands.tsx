import { useState } from 'react';
import { Button, StatusBanner } from '../ui';
import './spectator-controls.css';

const commands = [
  {
    label: '隐藏原生 HUD，保留击杀提示',
    command: 'cl_draw_only_deathnotices 1',
    copy: '复制隐藏命令',
  },
  { label: '恢复 CS2 原生 HUD', command: 'cl_draw_only_deathnotices 0', copy: '复制恢复命令' },
] as const;

export function SpectatorHudCommands({
  compact = false,
  onMessage,
}: {
  readonly compact?: boolean;
  readonly onMessage?: (message: string) => void;
}) {
  const [message, setMessage] = useState('');
  const [failed, setFailed] = useState(false);
  async function copy(command: string) {
    try {
      await navigator.clipboard.writeText(command);
      setFailed(false);
      const text = '已复制，尚未执行。请在 CS2 控制台粘贴并回车。';
      if (onMessage) onMessage(text);
      else setMessage(text);
    } catch {
      if (onMessage) {
        onMessage(`复制未完成，手动复制：${command}`);
        return;
      }
      setFailed(true);
      setMessage('复制未完成，请选取下方命令手动复制，再粘贴到 CS2 开发者控制台。');
    }
  }
  return (
    <section
      className={`spectator-hud-commands ${compact ? 'spectator-hud-commands--compact' : ''}`}
      aria-label="CS2 原生 HUD 命令"
    >
      {compact ? (
        <div className="spectator-hud-commands__buttons">
          {commands.map((item) => (
            <Button
              key={item.command}
              variant={item.command.endsWith(' 1') ? 'primary' : 'secondary'}
              title={`${item.label} · 复制后在 CS2 控制台执行`}
              onClick={() => void copy(item.command)}
            >
              {item.copy}
            </Button>
          ))}
        </div>
      ) : (
        <>
          <h2>CS2 观战 HUD 命令</h2>
          <p>
            需先在 CS2 游戏设置中启用开发者控制台。显示 Mizar HUD 时，可隐藏原生
            HUD，保留原生击杀提示；结束制作后使用恢复命令。
          </p>
          {commands.map((item) => (
            <div key={item.command}>
              <p>{item.label}</p>
              <p>
                <code>{item.command}</code>
              </p>
              <Button onClick={() => void copy(item.command)}>{item.copy}</Button>
            </div>
          ))}
        </>
      )}
      {message ? (
        <StatusBanner tone={failed ? 'warning' : 'success'}>{message}</StatusBanner>
      ) : null}
      {failed ? (
        <div className="spectator-hud-commands__fallback">
          {commands.map((item) => (
            <code key={item.command}>{item.command}</code>
          ))}
        </div>
      ) : null}
    </section>
  );
}
