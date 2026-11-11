import type { z } from 'zod';
import { desktopLifecycle } from './desktop-lifecycle.generated.js';

export { desktopLifecycle };
export type PreparationStatus = NonNullable<LifecycleResult<'preparation_status'>>;
export type WorkspaceExitStatus = LifecycleResult<'workspace_exit_status'>;
export type Cs2Status = LifecycleResult<'cs2_config_status'>;
export type Cs2ConfigStatus = Extract<Cs2Status, { busy: false }>;

type Contract = {
  args: z.ZodType<Record<string, unknown> | undefined>;
  result: z.ZodType;
};

export type DesktopLifecycleCommand = keyof typeof desktopLifecycle;
export type LifecycleArgs<C extends DesktopLifecycleCommand> = z.input<
  (typeof desktopLifecycle)[C]['args']
>;
export type LifecycleResult<C extends DesktopLifecycleCommand> = z.output<
  (typeof desktopLifecycle)[C]['result']
>;

export function desktopLifecycleContract(command: string): Contract | undefined {
  return Object.hasOwn(desktopLifecycle, command)
    ? desktopLifecycle[command as DesktopLifecycleCommand]
    : undefined;
}
