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
  test(`${style} shares bounded complete dashed flights and low-armor cleanup`, async ({
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
        if (this.lineWidth === 2 && this.getLineDash().join(',') === '7,6' && points.length >= 2)
          this.canvas.dataset.testFlight = JSON.stringify({
            first: points[0],
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
    const initialBox = await card.boundingBox();
    // Establish the flight only after asynchronous preset/font loading settles.
    radar.channelSeq++;
    radar.cursor.programSourceGeneration++;
    radar.cursor.programReceiveSequence = (radar.cursor.programReceiveSequence ?? 0) + 1;
    radarSocket!.send(JSON.stringify(radar));
    await expect(canvas).toHaveAttribute(
      'data-radar-sample-sequence',
      String(radar.cursor.programReceiveSequence),
    );
    await expect(canvas).toHaveAttribute('data-radar-trails', '1');
    let first: number[] | undefined;
    for (let index = 1; index <= 80; index++) {
      radar.channelSeq++;
      radar.cursor.runtimeSeq++;
      radar.cursor.programReceiveSequence = (radar.cursor.programReceiveSequence ?? 0) + 1;
      radar.payload.grenades[0]!.position!.x += 2;
      radarSocket!.send(JSON.stringify(radar));
      if (index === 1 || index === 80) {
        await expect(canvas).toHaveAttribute('data-radar-trails', String(Math.min(index + 1, 64)));
        await expect(canvas).toHaveAttribute('data-test-flight', /"count":/);
        await page.waitForTimeout(40);
        const path = JSON.parse((await canvas.getAttribute('data-test-flight'))!) as {
          first: number[];
          count: number;
          alpha: number;
        };
        if (index === 1) first = path.first;
        else {
          expect(path.first).toEqual(first);
          expect(path.count).toBe(64);
          expect(path.alpha).toBeCloseTo(0.72, 2);
        }
      } else await page.waitForTimeout(10);
    }
    program.channelSeq++;
    program.cursor.programReceiveSequence = (program.cursor.programReceiveSequence ?? 0) + 1;
    program.payload.players[0]!.state!.armor = 100;
    programSocket!.send(JSON.stringify(program));
    await expect(card.locator('.player-rail__low-armor')).toHaveCount(0);
    expect(await card.boundingBox()).toEqual(initialBox);
    radar.channelSeq++;
    radar.cursor.programReceiveSequence++;
    radar.payload.grenades = [];
    radarSocket!.send(JSON.stringify(radar));
    await expect(canvas).toHaveAttribute('data-radar-trails', '0');
  });
}
