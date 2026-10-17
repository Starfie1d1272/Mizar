import { describe, expect, it, vi } from 'vitest';
import { viewerDecoder, type ViewerEvent } from '../src/viewer-research.js';

const control = vi.hoisted(() => {
  class Events {
    listeners = new Map<string, ((...args: unknown[]) => void)[]>();
    on(name: string, callback: (...args: unknown[]) => void) {
      this.listeners.set(name, [...(this.listeners.get(name) ?? []), callback]);
    }
    emit(name: string, ...args: unknown[]) {
      for (const callback of this.listeners.get(name) ?? []) callback(...args);
    }
  }
  class Parser extends Events {
    currentTick = -1;
    gameEvents = new Events();
    constructor() {
      super();
      control.parser = this;
    }
  }
  return { Parser, parser: undefined as Parser | undefined };
});
vi.mock('cs2parser', () => ({ EntityMode: { ALL: 2 }, DemoReader: control.Parser }));

// Callback-level regression only; synthetic ticks are not a protocol/session fixture.
describe('viewer research source continuity', () => {
  const setup = () => {
    const output: ViewerEvent[] = [];
    viewerDecoder((event) => output.push(event));
    const parser = control.parser;
    if (!parser) throw new Error('missing-test-parser');
    parser.emit('serverinfo', { map_name: 'de_test', server_count: 1, tick_interval: 1 / 64 });
    return { output, parser };
  };
  it('rejects a regression inside the cursor throttle before emitting weapon_fire', () => {
    const { output, parser } = setup();
    for (const tick of [6400, 6463]) {
      parser.currentTick = tick;
      parser.emit('tickstart', tick);
      parser.gameEvents.emit('weapon_fire', { weapon: 'weapon_awp' });
      parser.emit('tickend', tick);
    }
    expect(output.filter((e) => e.kind === 'cursor').map((e) => e.tick)).toEqual([6400]);
    parser.currentTick = 6432;
    expect(() => parser.gameEvents.emit('weapon_fire', { weapon: 'weapon_awp' })).toThrow(
      'tick-regressed',
    );
    expect(output.filter((e) => e.kind === 'weapon_fire').map((e) => e.tick)).toEqual([6400, 6463]);
    parser.currentTick = 6464;
    expect(() => parser.emit('tickstart', 6464)).toThrow('tick-regressed');
  });
  it('sees un-emitted ticks and permits multiple events on an unchanged tick', () => {
    const { output, parser } = setup();
    parser.currentTick = 6400;
    parser.emit('tickstart', 6400);
    parser.gameEvents.emit('round_start', {});
    parser.gameEvents.emit('round_end', {});
    parser.emit('tickstart', 6463);
    expect(() => parser.emit('tickstart', 6432)).toThrow('tick-regressed');
    expect(output.map((e) => e.kind)).toEqual(['round_start', 'round_end']);
  });
});
