import { readFileSync } from 'node:fs';
import type { WebSocketRoute } from '@playwright/test';
import { getBuiltinResolvedPreset } from '../../packages/hud-config/src/index.js';
import { programSnapshotSchema } from '../../packages/protocol/src/program.js';
import { radarSnapshotSchema } from '../../packages/protocol/src/radar.js';
import { expect, test } from './companion-isolation.js';

const programArtifact = JSON.parse(
  readFileSync(
    'apps/web/src/program/fixtures/generated/real-program-fixtures.generated.json',
    'utf8',
  ),
) as { fixtures: Record<string, { snapshot: unknown }> };
const radarArtifact = JSON.parse(
  readFileSync(
    'apps/web/src/program/fixtures/generated/real-radar-fixtures.generated.json',
    'utf8',
  ),
) as { fixtures: Record<string, { samples: { snapshot: unknown }[] }> };

for (const style of ['mizar-default', 'ewc', 'iem', 'esl', 'perfectworld'] as const) {
  test(`${style} paints projectile motion and clears flight/low-armor information`, async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const preset = getBuiltinResolvedPreset(`builtin:${style}-preset`);
    preset.widgets.radar.settings.zoomMode =
      style === 'esl' || style === 'iem' ? 'auto' : 'full-map';
    const program = programSnapshotSchema.parse(
      programArtifact.fixtures['real-live-rich']!.snapshot,
    );
    program.payload.players[0]!.state!.armor = 7;
    const radar = radarSnapshotSchema.parse(
      radarArtifact.fixtures['dense-utility']!.samples[0]!.snapshot,
    );
    radar.payload.mapName = 'de_mirage';
    radar.payload.grenades = [
      {
        sourceEntityId: 'synthetic-flight',
        kind: 'frag',
        ownerSourceId: null,
        position: { x: -1000, y: 0, z: 0 },
        velocity: { x: 100, y: 0, z: 0 },
        lifetimeSeconds: 0,
        effectTimeSeconds: null,
        flames: [],
      },
    ];
    let programSocket: WebSocketRoute;
    let radarSocket: WebSocketRoute;
    await page.route('**/local/v1/hud-config', (route) =>
      route.fulfill({
        json: { resolved: preset, etag: 'polish', activeRevision: 'polish' },
      }),
    );
    await page.routeWebSocket('**/local/v1/program', (socket) => {
      programSocket = socket;
      socket.send(JSON.stringify(program));
    });
    await page.routeWebSocket('**/local/v1/radar', (socket) => {
      radarSocket = socket;
      socket.send(JSON.stringify(radar));
    });
    // Observe real Canvas calls without changing geometry, timing or drawing.
    await page.addInitScript(() => {
      const paths = new WeakMap<CanvasRenderingContext2D, number[][]>();
      const proto = CanvasRenderingContext2D.prototype;
      /* eslint-disable @typescript-eslint/unbound-method -- Instrumentation forwards the actual Canvas receiver via call/apply. */
      const begin = proto.beginPath;
      const move = proto.moveTo;
      const line = proto.lineTo;
      const stroke = proto.stroke;
      /* eslint-enable @typescript-eslint/unbound-method */
      proto.beginPath = function () {
        paths.set(this, []);
        return begin.call(this);
      };
      proto.moveTo = function (x, y) {
        paths.get(this)?.push([x, y]);
        return move.call(this, x, y);
      };
      proto.lineTo = function (x, y) {
        paths.get(this)?.push([x, y]);
        return line.call(this, x, y);
      };
      proto.stroke = function (path?: Path2D) {
        const points = paths.get(this) ?? [];
        if (this.getLineDash().length > 0 && points.length >= 2)
          this.canvas.dataset.testFlight = JSON.stringify({
            last: points.at(-1),
            count: points.length,
            alpha: this.globalAlpha,
          });
        Reflect.apply(stroke, this, path === undefined ? [] : [path]);
      };
    });
    await page.goto('/program?hud-config=companion');
    await expect(page.locator('[data-gameplay-hud]')).toHaveAttribute(
      'data-hud-preset-id',
      `builtin:${style}-preset`,
    );
    await page.evaluate(() => document.fonts.ready);
    const canvas = page.locator('[data-hud-widget="radar"] canvas.radar');
    await expect(canvas).toHaveAttribute('data-radar-projectile-ids', /synthetic-flight/);
    const armor = page.locator('.player-rail__low-armor');
    await expect(armor.first()).toHaveText('7');
    const firstId = program.payload.players[0]!.sourcePlayerId;
    const card = page.locator(`[data-player-card="${firstId}"]`);
    // This mocked-frame test controls receive intervals. Real wall-clock stalls must
    // not accidentally exercise the sampling-gap reset owned by presentation tests.
    const clockStart = new Date('2026-10-09T00:00:00Z');
    // Freeze Date before pausing so runner stalls cannot put the pause target
    // in the past. Restore advancing Date once timers are paused; runFor below
    // continues to exercise the real receive-gap and animation semantics.
    await page.clock.setFixedTime(clockStart);
    await page.clock.pauseAt(clockStart);
    await page.clock.setSystemTime(clockStart);
    const paintedSequence = () =>
      expect
        .poll(async () => {
          await page.clock.runFor(16);
          return canvas.getAttribute('data-radar-sample-sequence');
        })
        .toBe(String(radar.cursor.programReceiveSequence));
    // Establish the flight after asynchronous preset/font loading settles.
    radar.channelSeq++;
    radar.cursor.programSourceGeneration++;
    radar.cursor.programReceiveSequence = (radar.cursor.programReceiveSequence ?? 0) + 1;
    radarSocket!.send(JSON.stringify(radar));
    await paintedSequence();
    await expect(canvas).toHaveAttribute('data-radar-trails', '1');
    let previousPaint: number[] | undefined;
    for (let index = 1; index <= 2; index++) {
      await canvas.evaluate((element) => element.removeAttribute('data-test-flight'));
      radar.channelSeq++;
      radar.cursor.runtimeSeq++;
      radar.cursor.programReceiveSequence = (radar.cursor.programReceiveSequence ?? 0) + 1;
      radar.payload.grenades[0]!.position!.x += 2;
      radarSocket!.send(JSON.stringify(radar));
      await paintedSequence();
      await expect(canvas).toHaveAttribute('data-radar-trails', String(index + 1));
      await expect(canvas).toHaveAttribute('data-test-flight', /"count":/);
      const path = JSON.parse((await canvas.getAttribute('data-test-flight'))!) as {
        last: number[];
        count: number;
        alpha: number;
      };
      expect(path.count).toBeGreaterThanOrEqual(2);
      expect(path.alpha).toBeGreaterThan(0);
      expect(path.alpha).toBeLessThanOrEqual(1);
      if (previousPaint) expect(path.last).not.toEqual(previousPaint);
      previousPaint = path.last;
    }

    // Compare the armor transition itself, after preset layout and flight rendering settle.
    const initialBox = await card.boundingBox();
    program.channelSeq++;
    program.cursor.programReceiveSequence = (program.cursor.programReceiveSequence ?? 0) + 1;
    program.payload.players[0]!.state!.armor = 100;
    programSocket!.send(JSON.stringify(program));
    await page.clock.runFor(250);
    await expect(card.locator('.player-rail__low-armor')).toHaveCount(0);
    expect(await card.boundingBox()).toEqual(initialBox);
    radar.channelSeq++;
    radar.cursor.programReceiveSequence++;
    radar.payload.grenades = [];
    radarSocket!.send(JSON.stringify(radar));
    await paintedSequence();
    await expect(canvas).toHaveAttribute('data-radar-trails', '0');
  });
}
