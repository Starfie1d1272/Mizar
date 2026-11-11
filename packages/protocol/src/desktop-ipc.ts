import type { z } from 'zod';
import { desktopIpc } from './desktop-ipc.generated.js';

export { desktopIpc };
export type PreparationStatus = NonNullable<DesktopResult<'preparation_status'>>;
export type WorkspaceExitStatus = DesktopResult<'workspace_exit_status'>;
export type Cs2Status = DesktopResult<'cs2_config_status'>;
export type Cs2ConfigStatus = Extract<Cs2Status, { busy: false }>;

export type DesktopIpcCommand = keyof typeof desktopIpc;
export type DesktopArgs<C extends DesktopIpcCommand> = z.input<(typeof desktopIpc)[C]['args']>;
export type DesktopResult<C extends DesktopIpcCommand> = z.output<(typeof desktopIpc)[C]['result']>;
