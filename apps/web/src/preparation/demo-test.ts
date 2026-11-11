import type { DesktopResult } from '@mizar/protocol/desktop-ipc';

export type DemoTestView = DesktopResult<'start_demo_test'>;
export type SelectedDemo = NonNullable<DesktopResult<'select_demo_file'>>;
