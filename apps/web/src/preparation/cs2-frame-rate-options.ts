import type { DesktopArgs } from '@mizar/protocol/desktop-ipc';

export type Cs2FrameRateLimit = DesktopArgs<'set_cs2_preferences'>['frameRateLimit'];

export const CS2_FRAME_RATE_OPTIONS: readonly {
  readonly value: Cs2FrameRateLimit;
  readonly launchLabel: string;
  readonly liveLabel: string;
}[] = [
  { value: 60, launchLabel: '60 帧／秒（推荐）', liveLabel: '60 帧／秒' },
  { value: 90, launchLabel: '90 帧／秒', liveLabel: '90 帧／秒' },
  { value: 120, launchLabel: '120 帧／秒', liveLabel: '120 帧／秒' },
  { value: 144, launchLabel: '144 帧／秒', liveLabel: '144 帧／秒' },
  { value: 30, launchLabel: '30 帧／秒（省资源）', liveLabel: '30 帧／秒' },
  { value: 0, launchLabel: '不限帧（可能导致雷达卡顿）', liveLabel: '不限帧' },
];
