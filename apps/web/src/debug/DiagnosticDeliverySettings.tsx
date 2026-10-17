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
      setMessage({ error: false, text: '已记录问题时间。' });
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
    if (busy || (enabled && !value?.configured)) return;
    setBusy(true);
    setMessage(null);
    try {
      await command('/operator/diagnostics/consent', {
        enabled,
        revision: 'technical-diagnostics-v1',
      });
      setAccepted(false);
      setRefresh((v) => v + 1);
      setMessage({ error: false, text: enabled ? '已开启自动发送。' : '已关闭自动发送。' });
    } catch (error) {
      setMessage({ error: true, text: error instanceof Error ? error.message : '设置未能保存。' });
    } finally {
      setBusy(false);
    }
  }
  async function pause(paused: boolean) {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try {
      await command('/operator/diagnostics/pause', { paused });
      setRefresh((v) => v + 1);
      setMessage({ error: false, text: paused ? '已暂停发送。' : '已恢复发送。' });
    } catch (error) {
      setMessage({ error: true, text: error instanceof Error ? error.message : '设置未能保存。' });
    } finally {
      setBusy(false);
    }
  }
  const unavailable = !value?.available || !value.configured;
  return (
    <div>
      <p>
        自动发送诊断：
        {unavailable ? '暂不可用' : !value.consent ? '关闭' : value.paused ? '已暂停' : '已开启'}
      </p>
      {unavailable ? <p>仍可导出本机诊断报告。</p> : null}
      {value?.consent ? (
        <>
          <Button disabled={busy || unavailable} onClick={() => void pause(!value.paused)}>
            {value.paused ? '恢复发送' : '暂停发送'}
          </Button>
          <details>
            <summary>关闭并删除已发送诊断</summary>
            <p>关闭后停止发送，并请求维护者删除已发送的诊断。本机诊断记录保留。</p>
            <Button disabled={busy} onClick={() => void change(false)}>
              确认关闭并请求删除
            </Button>
          </details>
        </>
      ) : !unavailable ? (
        <details>
          <summary>开启自动发送诊断</summary>
          <p>
            将操作、错误、运行状态和相关配置发送至维护者管理的 Cloudflare
            服务，帮助排查问题。可能包含机器、路径、赛事和选手标识，并非匿名数据；密码和令牌等凭据会脱敏，不发送音视频或私人聊天。诊断正文保留七天，可识别的会话检索索引保留九十天；可随时暂停，或关闭并请求删除。
          </p>
          <Field
            label="我已阅读并同意发送诊断"
            type="checkbox"
            checked={accepted}
            onChange={(event) => setAccepted(event.target.checked)}
          />
          <Button disabled={busy || !accepted} onClick={() => void change(true)}>
            同意并开启
          </Button>
        </details>
      ) : null}
      {value?.deletionPending ? (
        <StatusBanner tone="warning">删除请求等待同步。</StatusBanner>
      ) : null}
      {value?.error ? (
        <StatusBanner tone="warning">暂时无法发送，诊断记录保留在本机。</StatusBanner>
      ) : null}
      {message ? (
        <StatusBanner tone={message.error ? 'danger' : 'success'}>{message.text}</StatusBanner>
      ) : null}
      <details>
        <summary>诊断详情</summary>
        <p>本机保留完整证据。云端拒收或网络不可用时保留待传副本，缺失范围记录在诊断中。</p>
        {value ? (
          <p>
            待传 {value.queuedBatches} 批 · 已确认 {value.acknowledged} 批
            {value.omitted ? ` · ${value.omitted} 次缺失或预算记录` : ''}
          </p>
        ) : null}
      </details>
      <DiagnosticProblemReport />
    </div>
  );
}
