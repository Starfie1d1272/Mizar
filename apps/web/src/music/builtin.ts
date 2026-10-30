import { musicConfigSchema } from '@mizar/protocol/music';
import { command } from '../preparation/client';

export async function loadBuiltinMusic() {
  const result = await command('/operator/music/builtin');
  return musicConfigSchema.parse((result as { config?: unknown }).config);
}
