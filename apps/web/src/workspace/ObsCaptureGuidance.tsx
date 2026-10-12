import type { ObsCaptureDiagnostic } from '@mizar/protocol/obs';
import { Button, StatusBanner } from '../ui';

export function ObsCaptureGuidance({
  diagnostic,
  busy,
  onCheck,
}: {
  diagnostic: ObsCaptureDiagnostic | null | undefined;
  busy: boolean;
  onCheck: () => void;
}) {
  if (diagnostic?.state !== 'needs_attention') return null;
  const locked =
    diagnostic.reason === 'hook_file_locked' ||
    diagnostic.lastFailure?.reason === 'hook_file_locked';
  const message =
    diagnostic.reason === 'access_denied'
      ? 'OBS 打开游戏进程被拒绝（错误 5）。请核对 OBS 与 CS2 的运行权限。'
      : diagnostic.reason === 'process_open_failed'
        ? 'OBS 无法打开游戏进程，具体原因未确认。请确认 CS2 正在运行。'
        : diagnostic.reason === 'hook_file_locked'
          ? 'OBS 捕获文件被占用（错误 32），占用程序未知。'
          : diagnostic.reason === 'hook_pending'
            ? 'OBS 游戏挂钩尚未就绪。'
            : 'OBS 报告捕获失败，具体原因见诊断包。';
  return (
    <>
      <StatusBanner tone="warning">{message}</StatusBanner>
      <details className="obs-setup__help">
        <summary>处理捕获问题</summary>
        {diagnostic.reason === 'access_denied' ? (
          <p>
            打开 Windows「任务管理器 → 详细信息」，右键列标题，在「选择列」中勾选「已提升」，核对
            obs64.exe 与 cs2.exe。若 CS2 已提升而 OBS 未提升，先保存工作并停止输出，正常退出
            OBS，再由你手动选择「以管理员身份运行」并重新检测；Mizar
            不会自动提权。权限一致仍失败时导出诊断包，继续核对具体拒绝原因。
          </p>
        ) : locked ? (
          <p>
            最近日志报告捕获文件被占用，占用程序未知。保存工作，正常退出可能使用捕获功能的程序，再正常退出并重开
            OBS。
          </p>
        ) : (
          <p>保存工作，核对游戏与 OBS 状态后，正常退出并重开 OBS。</p>
        )}
        <p>
          重新检测后在 OBS 核对实际画面。仍无画面时，可在 OBS 临时添加「窗口采集」并选择
          CS2，检查画面与音频后再播出。
        </p>
        <Button disabled={busy} loading={busy} onClick={onCheck}>
          重新检测捕获
        </Button>
      </details>
    </>
  );
}
