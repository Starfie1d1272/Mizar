import { useState } from 'react';
import { Button, Field, Panel, StatusBanner } from '../ui';
import { useLocalRead } from './client';
import { desktopInvoke } from '../workspace/client';

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
      <h2>Steam 头像（可选）</h2>
      <p>
        推荐填写 Steam Web API Key。保存后自动按当前选手的 Steam64 获取 Steam
        头像并缓存在本机，赛事提供的头像优先。不填写也能正常使用 HUD，显示已有头像或观察编号。
      </p>
      <p>
        {status?.configured ? '已配置密钥' : '尚未配置密钥'} · 本机缓存 {status?.cached ?? 0} 个头像
      </p>
      <p>
        <a
          href="https://steamcommunity.com/dev/apikey"
          target="_blank"
          rel="noopener noreferrer"
          onClick={(event) => {
            if (!window.__TAURI_INTERNALS__) return;
            event.preventDefault();
            void desktopInvoke('open_steam_api_key').catch(() =>
              setMessage('浏览器未能打开，请手动访问 https://steamcommunity.com/dev/apikey。'),
            );
          }}
        >
          获取 Steam Web API Key（Steam 官方）
        </a>
      </p>
      <ol>
        <li>在浏览器中登录 Steam，按官方页面提示申请或查看已有 Key。</li>
        <li>
          申请页的域名（Domain Name）建议填写 <code>localhost</code>
          ，表示在本机使用，不需要购买或配置域名。
        </li>
        <li>复制 32 位 Key 到下方输入框并保存，当前选手的备用头像会自动加载。</li>
      </ol>
      <p>若 Steam 提示账号暂不能申请，可跳过此项，不影响 HUD 使用。</p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void save('configure');
        }}
      >
        <Field
          label="Steam Web API Key（可选，推荐填写）"
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
