import { useState } from 'react';
import { Button, Select } from '../ui';

type Devices = {
  desktopMode: boolean;
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
    <section>
      <h3>采集设备</h3>
      <p>
        设置「桌面声音」和「麦克风」的实际设备。请先停止直播与录像；更换设备不会改变静音、音量或场景启用状态。
      </p>
      <Button disabled={disabled || busy} aria-busy={busy} onClick={() => void run(read)}>
        读取设备
      </Button>
      {devices?.desktopMode && (
        <p>
          更换桌面设备前，请先切到独立分路（可选择暂不采集其他解说），保存设备后再切回桌面混音，以重新核对音乐监听。麦克风设备可直接更换。
        </p>
      )}
      {devices?.devices.map((device) => (
        <div key={device.role}>
          <Select
            label={device.name}
            disabled={
              disabled ||
              busy ||
              !device.configurable ||
              (device.role === 'desktop' && devices.desktopMode)
            }
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
              (device.role === 'desktop' && devices.desktopMode) ||
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
    </section>
  );
}
