import { useState } from 'react';
import { Button, Field, Select, StatusBanner } from '../ui';
import { command, useLocalRead } from '../preparation/client';
interface DeliveryStatus {
  available: boolean;
  configured: boolean;
  consent: boolean;
  paused?: boolean;
  queuedBatches: number;
  queuedBytes: number;
  acknowledged: number;
  deletionPending: number;
  omitted?: number;
  error?: string | null;
}
export function DiagnosticProblemReport() {
  const [category, setCategory] = useState('hud');
  const [minutesAgo, setMinutesAgo] = useState('0');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null);
  async function report() {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try {
      await command('/operator/diagnostics/report', {
        category,
        observedAt: new Date(Date.now() - Number(minutesAgo) * 60000).toISOString(),
      });
      setMessage({ error: false, text: '已在本机标记问题时间并保存上下文；这不代表云端已收到。' });
    } catch (error) {
      setMessage({
        error: true,
        text: error instanceof Error ? error.message : '问题时间未能保存。',
      });
    } finally {
      setBusy(false);
    }
  }
  return (
    <details>
      <summary>标记本场问题</summary>
      <Select
        label="问题类型"
        value={category}
        onChange={(event) => setCategory(event.target.value)}
      >
        <option value="hud">HUD 停顿或显示异常</option>
        <option value="music">音乐</option>
        <option value="workspace">进入或退出工作台</option>
        <option value="recovery">故障恢复</option>
        <option value="other">其他</option>
      </Select>
      <Select
        label="发生时间"
        value={minutesAgo}
        onChange={(event) => setMinutesAgo(event.target.value)}
      >
        <option value="0">刚才</option>
        <option value="1">约一分钟前</option>
        <option value="5">约五分钟前</option>
        <option value="15">约十五分钟前</option>
      </Select>
      <Button disabled={busy} onClick={() => void report()}>
        保存问题标记
      </Button>
      {message ? (
        <StatusBanner tone={message.error ? 'danger' : 'success'}>{message.text}</StatusBanner>
      ) : null}
    </details>
  );
}
export function DiagnosticDeliverySettings() {
  const [refresh, setRefresh] = useState(0);
  const value = useLocalRead<DeliveryStatus>('/local/v1/diagnostics/delivery', 5000, refresh);
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null);
  async function change(enabled: boolean) {
    setBusy(true);
    setMessage(null);
    try {
      await command('/operator/diagnostics/consent', {
        enabled,
        revision: 'technical-diagnostics-v1',
      });
      setAccepted(false);
      setRefresh((v) => v + 1);
      setMessage({
        error: false,
        text: enabled
          ? '已保存同意；仅在接收端配置完成后按预算回传。'
          : '已停止回传并清理待传内容；云端删除状态见下方。',
      });
    } catch (error) {
      setMessage({ error: true, text: error instanceof Error ? error.message : '设置未能保存。' });
    } finally {
      setBusy(false);
    }
  }
  async function pause(paused: boolean) {
    setBusy(true);
    setMessage(null);
    try {
      await command('/operator/diagnostics/pause', { paused });
      setRefresh((v) => v + 1);
      setMessage({
        error: false,
        text: paused
          ? '已暂停回传，本机记录和待传副本继续保留。'
          : '已恢复回传；仍受接收端配置和预算限制。',
      });
    } catch (error) {
      setMessage({
        error: true,
        text: error instanceof Error ? error.message : '暂停设置未能保存。',
      });
    } finally {
      setBusy(false);
    }
  }
  return (
    <div>
      <p>
        技术诊断回传默认关闭。内容可能含机器、文件路径、赛事和选手标识，并非匿名数据；凭据会脱敏，不回传音视频、私人聊天或整份原始
        GSI。
      </p>
      <p>
        完整证据保留在本机。云端有容量限制，拒收时保留待传副本并显示积压，不代表完整会话已上云。
      </p>
      {!value?.configured ? <p>云端接收端尚未配置：当前不会上传，也不会使用 R2。</p> : null}
      {value?.consent ? (
        <>
          <Button disabled={busy} onClick={() => void pause(!value.paused)}>
            {value.paused ? '恢复回传' : '暂停回传（保留本地待传）'}
          </Button>
          <details>
            <summary>撤回同意与删除</summary>
            <p>
              撤回会清除待传副本并请求删除已传诊断；本机原始诊断日志不删除。断网时云端删除需等待同步确认。
            </p>
            <Button disabled={busy} onClick={() => void change(false)}>
              确认撤回并请求删除
            </Button>
          </details>
        </>
      ) : (
        <>
          <Field
            label="我已阅读并同意回传技术诊断"
            type="checkbox"
            checked={accepted}
            onChange={(event) => setAccepted(event.target.checked)}
          />
          <Button
            disabled={busy || !accepted || !value?.available}
            onClick={() => void change(true)}
          >
            同意并保存设置
          </Button>
        </>
      )}
      {value ? (
        <p>
          待传 {value.queuedBatches} 批 · 已确认 {value.acknowledged} 批
          {value.deletionPending ? ` · ${value.deletionPending} 份云端删除待同步` : ''}
          {value.omitted ? ` · ${value.omitted} 次云副本缺失或预算记录，详情见本机诊断` : ''}
        </p>
      ) : null}
      {value?.error ? (
        <StatusBanner tone="warning">诊断回传暂不可用，本机制播继续；请导出本机诊断。</StatusBanner>
      ) : null}
      {message ? (
        <StatusBanner tone={message.error ? 'danger' : 'success'}>{message.text}</StatusBanner>
      ) : null}
      <DiagnosticProblemReport />
    </div>
  );
}
