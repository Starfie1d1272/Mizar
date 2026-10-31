import { useState } from 'react';
import { CAMERA_STAGES, type OrchestrationView } from '@mizar/protocol/orchestration';
import { Button, Select, StatusBanner } from '../ui';
import { command, useLocalRead } from '../preparation/client';
import { MUSIC_LABELS } from '../music/MusicControls';

export function CameraAudition() {
  const current = useLocalRead<OrchestrationView>('/local/v1/orchestration', 1500);
  const [audition, setAudition] = useState('opening');
  const [lastPlayed, setLastPlayed] = useState<{ shot: string; context: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [failed, setFailed] = useState(false);
  const currentMap = current?.preset.maps.find((map) => map.map === current.status.map);
  const shots = [
    ...(currentMap?.opening
      ? [{ value: 'opening', label: `开场 · ${currentMap.opening.macro}` }]
      : []),
    ...CAMERA_STAGES.flatMap((stage) =>
      currentMap?.stages[stage]
        ? [
            {
              value: stage,
              label: `${stage === 'warmup' ? '热身' : MUSIC_LABELS[stage]} · ${currentMap.stages[stage].macro}`,
            },
          ]
        : [],
    ),
    ...(['tactical', 'technical'] as const).flatMap((stage) =>
      (currentMap?.pauseCandidates[stage] ?? []).map((shot, index) => ({
        value: `${stage}:${index}`,
        label: `${MUSIC_LABELS[stage]} · ${shot.macro}`,
      })),
    ),
    ...(currentMap?.rounds.map((shot, index) => ({
      value: `round:${index}`,
      label: `回合 · ${shot.macro}`,
    })) ?? []),
  ];
  const selectedShot = shots.some((shot) => shot.value === audition) ? audition : shots[0]?.value;
  const shotIndex = shots.findIndex((shot) => shot.value === selectedShot);
  const playDisabled =
    busy ||
    !current?.ready ||
    !current.status.connected ||
    !current.status.isolated ||
    !selectedShot ||
    current.status.preparation === 'preparing';
  const action = async (run: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setMessage('');
    setFailed(false);
    try {
      await run();
    } catch (error) {
      setFailed(true);
      setMessage(error instanceof Error ? error.message : '操作未完成，请重试。');
    } finally {
      setBusy(false);
    }
  };
  const play = (shot = selectedShot) =>
    void action(async () => {
      if (!current || !shot) return;
      const [stage, index] = shot.split(':');
      await command('/operator/orchestration', {
        action: 'audition',
        stage,
        ...(index !== undefined ? { index: Number(index) } : {}),
        expected: { context: current.status.context, connection: current.status.connection },
      });
      setLastPlayed({ shot, context: current.status.context });
      setMessage('已发送播放请求。');
    });
  return (
    <>
      <section aria-label="试播">
        <h3>试播</h3>
        <p>试播当前地图已保存的镜头，播放后保持手动运镜。</p>
        <p>当前地图：{current?.status.map ?? '等待游戏数据'}</p>
        <Select
          label="试播镜头"
          value={selectedShot ?? ''}
          onChange={(e) => setAudition(e.target.value)}
        >
          {!shots.length ? (
            <option value="">{current?.status.map ? '当前地图暂无镜头' : '等待游戏数据'}</option>
          ) : null}
          {shots.map((shot) => (
            <option key={shot.value} value={shot.value}>
              {shot.label}
            </option>
          ))}
        </Select>
        <Button disabled={playDisabled} onClick={() => play()}>
          播放
        </Button>
        {lastPlayed &&
        lastPlayed.shot === selectedShot &&
        lastPlayed.context === current?.status.context ? (
          <Button disabled={playDisabled} onClick={() => play()}>
            重播
          </Button>
        ) : null}
        <Button
          disabled={playDisabled || shotIndex <= 0}
          onClick={() => {
            const shot = shots[shotIndex - 1]!.value;
            setAudition(shot);
            play(shot);
          }}
        >
          上一条
        </Button>
        <Button
          disabled={playDisabled || shotIndex < 0 || shotIndex >= shots.length - 1}
          onClick={() => {
            const shot = shots[shotIndex + 1]!.value;
            setAudition(shot);
            play(shot);
          }}
        >
          下一条
        </Button>
        {current?.status.current ? (
          <Button
            disabled={busy}
            onClick={() =>
              void action(async () => {
                await command('/operator/orchestration', { action: 'hold' });
                setMessage('已请求停止，请在游戏内核对。');
              })
            }
          >
            停止
          </Button>
        ) : null}
        {!current ? <p role="status">正在读取运镜状态…</p> : null}
        {current && !current.status.connected ? (
          <p>运镜工具尚未就绪，请检查试播游戏状态。</p>
        ) : null}
        {current?.status.connected && !current.status.isolated ? (
          <p>当前地图的镜头尚未准备好，请检查预设和镜头资源。</p>
        ) : null}
        {current?.status.preparation === 'error' ? (
          <p>运镜准备失败，请检查预设和游戏状态后重试。</p>
        ) : null}
        {current?.status.current ? <p>切换镜头时会先请求停止当前镜头。</p> : null}
      </section>
      {message ? <StatusBanner tone={failed ? 'danger' : 'info'}>{message}</StatusBanner> : null}
    </>
  );
}
