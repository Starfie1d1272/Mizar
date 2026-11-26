import { useState } from 'react';
import { Button, Select } from '../ui';

type Devices = {
  revision: string;
  devices: {
    role: 'desktop' | 'microphone';
    name: string;
    configurable: boolean;
    deviceId: string | null;
    candidates: { id: string; label: string }[];
  }[];
};
export function ObsAudioDevices({ disabled }: { disabled: boolean }) {
  const [devices, setDevices] = useState<Devices | null>(null);
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  async function read() {
    setDevices(null);
    setChoices({});
    const response = await fetch('/local/v1/obs/audio-devices', { cache: 'no-store' });
    if (!response.ok) throw new Error('无法读取设备，请先准备 OBS 场景并核对连接。');
    const value = (await response.json()) as Devices;
    setDevices(value);
    setChoices(
      Object.fromEntries(value.devices.map((device) => [device.role, device.deviceId ?? ''])),
    );
  }
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setMessage('');
    try {
      await action();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '设备设置未确认。');
    } finally {
      setBusy(false);
    }
  }
  async function save(role: 'desktop' | 'microphone') {
    if (!devices) return;
    const response = await fetch('/operator/obs/audio-device', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ revision: devices.revision, role, deviceId: choices[role] }),
    });
    if (!response.ok) {
      setDevices(null);
      setChoices({});
      const result = (await response.json()) as { message?: string };
      throw new Error(result.message ?? '设备设置未确认，请重新读取后核对。');
    }
    await read();
    setMessage('设备已保存，请录制试听。');
  }
  return (
    <details
      className="sound-sources__advanced"
      onToggle={(event) => {
        if (event.currentTarget.open && !devices && !message && !disabled && !busy) void run(read);
      }}
    >
      <summary>采集设备</summary>
      {disabled && <p>OBS 就绪且输出停止后可更换设备。</p>}
      <Button disabled={disabled || busy} aria-busy={busy} onClick={() => void run(read)}>
        {busy ? '正在读取设备…' : '重新读取设备'}
      </Button>
      {devices?.devices.map((device) => (
        <div key={device.role}>
          <Select
            label={device.name}
            disabled={disabled || busy || !device.configurable}
            value={choices[device.role] ?? ''}
            onChange={(event) => setChoices({ ...choices, [device.role]: event.target.value })}
          >
            <option value="">请选择设备</option>
            {device.candidates.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.label}
              </option>
            ))}
          </Select>
          <Button
            disabled={
              disabled ||
              busy ||
              !device.configurable ||
              !choices[device.role] ||
              choices[device.role] === device.deviceId
            }
            onClick={() => void run(() => save(device.role))}
          >
            保存设备
          </Button>
          {!device.configurable && (
            <p>
              当前麦克风沿用迁入的应用音频来源，请在 OBS
              核对该来源的应用目标；桌面采集设备仍可独立设置。
            </p>
          )}
          {device.configurable &&
            !device.candidates.some((candidate) => candidate.id === device.deviceId) && (
              <p>原设备不可用，请重新选择。</p>
            )}
        </div>
      ))}
      {message && <p role="status">{message}</p>}
    </details>
  );
}
