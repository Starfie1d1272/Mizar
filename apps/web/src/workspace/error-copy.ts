/**
 * Operator-facing copy for desktop command failures.
 *
 * Tauri commands reject with a string that often names an internal ownership or
 * state-machine term. The raw string is still recorded in diagnostics by
 * desktopInvoke; this module only decides what the operator sees.
 */
const MAPPINGS: readonly (readonly [RegExp, string])[] = [
  [/受管游戏来源/, '这次结束制作没有完成。请先退出 CS2，再重试；仍然失败时重新打开 Mizar。'],
  [/受管来源/, '游戏配置恢复没有完成。请点“重试结束制作”；仍然失败时重新打开 Mizar。'],
  [/受管游戏/, '当前游戏状态已经变化。请确认 CS2 已退出后重试。'],
  [/本场回收资格|退出资格/, '本场收尾还没有确认。请重试；仍然失败时导出诊断。'],
  [/游戏实例/, 'CS2 状态已经变化。请重新检查游戏后重试。'],
  [/本地服务/, 'Mizar 后台服务连接中断。请重新打开 Mizar。'],
  [/制播服务启动超时/, 'Mizar 后台服务启动超时。请重新打开 Mizar；多次失败请导出诊断。'],
];

export function userFacingError(message: string): string {
  for (const [pattern, copy] of MAPPINGS) {
    if (pattern.test(message)) return copy;
  }
  if (/Companion|Host|state\/logs|ticket|qualification|generation|journal/i.test(message))
    return 'Mizar 后台服务没有完成操作。请重试；仍然失败时导出诊断。';
  return message;
}
