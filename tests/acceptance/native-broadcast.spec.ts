import { readFileSync } from 'node:fs';
import { programSnapshotSchema } from '../../packages/protocol/src/program.js';
import { expect, test } from './companion-isolation.js';

const artifact = JSON.parse(
  readFileSync(
    new URL(
      '../../apps/web/src/program/fixtures/generated/real-program-fixtures.generated.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as { fixtures: Record<string, { snapshot: unknown }> };
function sample(id: string) {
  return programSnapshotSchema.parse(artifact.fixtures[id]!.snapshot);
}

test('a ten-second action with unknown kit evidence paints a determinate defuse ring', async ({
  page,
}) => {
  const snapshot = sample('real-defusing');
  // Core's actual RC14 input regression proves this semantic action; this edge
  // verifies the browser does not gate the ring on optional equipment evidence.
  snapshot.payload.bomb!.action = {
    kind: 'defuse',
    sourcePlayerId: snapshot.payload.bomb!.sourcePlayerId,
    remainingSeconds: 9,
    durationSeconds: 10,
    hasDefuseKit: null,
  };
  await page.routeWebSocket('**/local/v1/program', (socket) =>
    socket.send(JSON.stringify(snapshot)),
  );
  await page.goto('/program');
  const ring = page.locator('.objective-center__ring');
  await expect(ring).toHaveAttribute('data-progress', 'determinate');
  await expect(ring.locator('.objective-center__ring-fill')).toHaveAttribute(
    'stroke-dashoffset',
    '0.9',
  );
});
