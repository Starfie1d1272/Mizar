import { useState } from 'react';
import { Button, StatusBanner } from '../ui';
import { desktopInvoke } from '../workspace/client';
import './spectator-controls.css';

export const HIDE_SPECTATOR_HUD_COMMAND = 'cl_draw_only_deathnotices 1';
const OBSERVER_CFG_COMMAND = 'exec mizar_observer.cfg';

const commands = [
  {
    label: '隐藏原生 HUD，保留击杀提示',
    command: HIDE_SPECTATOR_HUD_COMMAND,
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
  const [cfgBusy, setCfgBusy] = useState(false);
  const [cfgPrepared, setCfgPrepared] = useState(false);
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
  async function prepareAndCopyCfg() {
    setCfgBusy(true);
    setCfgPrepared(false);
    try {
      const result = await desktopInvoke<{ cfgReady?: boolean }>('observer_command', {
        action: 'prepare-cfg',
      });
      if (!result?.cfgReady) throw new Error('未能确认解说配置已准备。');
      setCfgPrepared(true);
      try {
        await navigator.clipboard.writeText(OBSERVER_CFG_COMMAND);
        setFailed(false);
        const text = '已复制；请在游戏控制台粘贴执行，执行结果尚未确认。';
        if (onMessage) onMessage(text);
        else setMessage(text);
      } catch {
        setFailed(true);
        const text = '配置已准备，请手动复制下方命令，在游戏控制台粘贴执行。';
        if (onMessage) onMessage(text);
        else setMessage(text);
      }
    } catch (error) {
      setFailed(true);
      const text = error instanceof Error ? error.message : '解说配置未能准备，请检查当前游戏。';
      if (onMessage) onMessage(text);
      else setMessage(text);
    } finally {
      setCfgBusy(false);
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
          <header>
            <h2>CS2 原生 HUD</h2>
            <p>在 CS2 设置中启用开发者控制台，复制命令后粘贴执行。</p>
          </header>
          <div className="spectator-hud-commands__items">
            {commands.map((item) => (
              <article key={item.command}>
                <h3>{item.label}</h3>
                <code>{item.command}</code>
                <Button onClick={() => void copy(item.command)}>{item.copy}</Button>
              </article>
            ))}
          </div>
        </>
      )}
      {window.__TAURI_INTERNALS__ ? (
        <div>
          <p>借用外部游戏时，可在控制台手动执行解说配置。键位可能持久变化，Mizar 不会自动恢复。</p>
          <Button disabled={cfgBusy} onClick={() => void prepareAndCopyCfg()}>
            {cfgBusy ? '正在准备解说配置' : '准备并复制解说配置命令'}
          </Button>
          {cfgPrepared && failed ? <code>{OBSERVER_CFG_COMMAND}</code> : null}
        </div>
      ) : null}
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
