import { useState } from 'react';
import { Button, StatusBanner } from '../ui';

const commands = [
  {
    label: '隐藏原生 HUD，保留击杀提示',
    command: 'cl_draw_only_deathnotices 1',
    copy: '复制隐藏命令',
  },
  { label: '恢复 CS2 原生 HUD', command: 'cl_draw_only_deathnotices 0', copy: '复制恢复命令' },
] as const;

export function SpectatorHudCommands() {
  const [message, setMessage] = useState('');
  const [failed, setFailed] = useState(false);
  async function copy(command: string) {
    try {
      await navigator.clipboard.writeText(command);
      setFailed(false);
      setMessage('已复制，尚未执行。请粘贴到 CS2 开发者控制台并按回车。');
    } catch {
      setFailed(true);
      setMessage('复制未完成，请选取下方命令手动复制，再粘贴到 CS2 开发者控制台。');
    }
  }
  return (
    <section aria-label="CS2 观战 HUD 命令">
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
      {message ? (
        <StatusBanner tone={failed ? 'warning' : 'success'}>{message}</StatusBanner>
      ) : null}
    </section>
  );
}
