import { useState } from 'react';
import { Button, Field, Panel, StatusBanner } from '../ui';
import { useLocalRead } from './client';

export function SteamAvatarSettings() {
  const status = useLocalRead<{ configured: boolean; cached: number; unavailable: boolean }>(
    '/local/v1/steam-avatars',
    3000,
  );
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  async function save(action: 'configure' | 'clear', remove = false) {
    if (busy) return;
    setBusy(true);
    setMessage('');
    try {
      const response = await fetch('/operator/steam-avatars', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action,
          ...(action === 'configure' ? { key: remove ? '' : key.trim() } : {}),
        }),
      });
      if (!response.ok) throw new Error('设置未保存，请检查密钥格式和运行目录权限。');
      setKey('');
      setMessage(
        action === 'clear'
          ? '头像缓存已清除。'
          : remove
            ? '已停用在线头像获取；已缓存头像仍可使用。'
            : '已保存，缺少赛事头像的当前选手将自动获取 Steam 头像。',
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '头像设置未完成。');
    } finally {
      setBusy(false);
    }
  }
  return (
    <Panel>
      <h2>Steam 头像</h2>
      <p>
        赛事提供的头像优先。填写 Steam Web API Key 后，可按当前选手的 Steam64
        批量获取备用头像并缓存在本机。
      </p>
      <p>
        {status?.configured ? '已配置密钥' : '尚未配置密钥'} · 本机缓存 {status?.cached ?? 0} 个头像
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void save('configure');
        }}
      >
        <Field
          label="Steam Web API Key"
          type="password"
          autoComplete="off"
          value={key}
          onChange={(event) => setKey(event.target.value)}
          message="密钥仅保存在本机设置中，不写入比赛资料、预设或诊断包。"
        />
        <div className="preparation-actions">
          <Button type="submit" disabled={busy || !key.trim()}>
            保存密钥
          </Button>
          <Button
            disabled={busy || !status?.configured}
            onClick={() => void save('configure', true)}
          >
            停用在线获取
          </Button>
          <Button disabled={busy || !status?.cached} onClick={() => void save('clear')}>
            清除头像缓存
          </Button>
        </div>
      </form>
      {status?.configured && status.unavailable ? (
        <StatusBanner tone="warning">
          Steam 头像暂时无法获取，请检查密钥与网络；现有媒体和观察编号继续显示。
        </StatusBanner>
      ) : null}
      {message ? <StatusBanner tone="info">{message}</StatusBanner> : null}
    </Panel>
  );
}
