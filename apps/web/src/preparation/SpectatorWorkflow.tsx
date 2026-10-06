import { Panel } from '../ui';
import { useCs2Status } from './cs2-status';
import type { Production } from './client';

export function SpectatorWorkflow({
  capabilities,
  production,
}: {
  capabilities: readonly { label: string; ready: boolean; reason: string }[] | null;
  production: Production | null;
}) {
  const { status } = useCs2Status();
  const gameData = capabilities?.find((item) => item.label === 'CS2 / GSI');
  const identity = capabilities?.find((item) => item.label === '选手身份');
  const obs = capabilities?.find((item) => item.label === 'OBS');
  return (
    <Panel className="spectator-workflow">
      <h2>开播流程</h2>
      <ol>
        <li>
          <a href="/settings?tab=gsi">安装 / 检查 GSI</a>
          <span>首次先安装，已打开的 CS2 请先退出。</span>
        </li>
        <li>
          <a href="/settings?tab=obs">配置 OBS 服务器</a>
          <span>
            在 OBS「工具 → WebSocket 服务器设置」启用服务，填写端口与密码，检查 Mizar 场景。
            {obs?.ready ? '连接与场景检查已通过。' : ''}
          </span>
        </li>
        <li>
          <strong>{status?.running ? 'CS2 已启动' : '从 Mizar 启动游戏'}</strong>
          <span>
            点击右上角「
            {production?.mode === 'preparation' && window.__TAURI_INTERNALS__
              ? '启动游戏并打开工作台'
              : '打开直播工作台'}
            」，或在游戏数据设置中提前启动。
          </span>
        </li>
        <li>
          <strong>{gameData?.ready ? '已收到游戏数据' : '连接本场 GOTV'}</strong>
          <span>
            在 CS2 开发者控制台输入赛事方提供的 <code>connect &lt;GOTV 地址&gt;</code> 并回车。
            {gameData?.ready ? '核对队伍、名单与地图。' : '进入观战后，游戏数据状态会自动更新。'}
            {identity?.ready ? '名单已匹配。' : ''}
          </span>
        </li>
        <li>
          <a href="/picture?tab=overlay">隐藏 CS2 原生 HUD</a>
          <span>复制命令，在 CS2 控制台粘贴并回车。</span>
        </li>
        <li>
          <a href="/settings?tab=obs">检查 OBS 实际画面</a>
          <span>核对游戏、HUD、声音，再在 OBS 开始推流。</span>
        </li>
      </ol>
    </Panel>
  );
}
