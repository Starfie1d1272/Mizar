import { isAbsolute, join } from 'node:path';
import { SupportExports } from './export-job.js';

const [stateRoot] = process.argv.slice(2);
if (!stateRoot || !isAbsolute(stateRoot)) throw new Error('absolute_state_root_required');

const exports = new SupportExports(join(stateRoot, 'logs'));
const started = await exports.begin({}, null);
const settled = await exports.whenSettled(started.exportId);
process.stdout.write(
  JSON.stringify(
    settled?.phase === 'ready'
      ? { exportId: settled.exportId }
      : { error: settled?.error ?? 'export_result_missing' },
  ),
);
