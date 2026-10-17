/** Research-only scalar event outlet. This module implements NO online GOTV transport. */
import { DemoReader, EntityMode } from 'cs2parser';

export interface ViewerEvent {
  kind: 'cursor' | 'weapon_fire' | 'player_death' | 'round_start' | 'round_end';
  tick: number;
  tickInterval: number | null;
  map: string | null;
  warmup: boolean | null;
  round: number | null;
  weapon: string | null;
  actor: string | null;
  target: string | null;
}

export function viewerDecoder(emit: (event: ViewerEvent) => void) {
  const parser = new DemoReader();
  let map: string | null = null;
  let interval: number | null = null;
  let serverCount: number | undefined;
  let lastCursor = -Infinity;
  parser.on('serverinfo', (info) => {
    if (map && (map !== info.map_name || serverCount !== info.server_count)) {
      throw new Error('map-or-server-changed: start a new stream instance');
    }
    map = info.map_name ?? null;
    serverCount = info.server_count;
    interval = info.tick_interval ?? null;
    if (!map || interval === null || !(interval > 0 && interval <= 1)) {
      throw new Error('invalid-source-clock');
    }
  });
  const send = (
    kind: ViewerEvent['kind'],
    weapon: string | null = null,
    actor: string | null = null,
    target: string | null = null,
  ) => {
    const props = parser.gameRules?.entity?.properties;
    const warmup = props?.['CCSGameRulesProxy.CCSGameRules.m_bWarmupPeriod'];
    const round = props?.['CCSGameRulesProxy.CCSGameRules.m_totalRoundsPlayed'];
    emit({
      kind,
      tick: parser.currentTick,
      tickInterval: interval,
      map,
      warmup: typeof warmup === 'boolean' ? warmup : null,
      round: typeof round === 'number' ? round : null,
      weapon,
      actor,
      target,
    });
  };
  const id = (value: string | undefined): string | null =>
    value && /^7656119\d{10}$/.test(value) ? value : null;
  parser.on('tickend', () => {
    if (!map || parser.currentTick < 0) return;
    if (parser.currentTick < lastCursor) throw new Error('tick-regressed');
    if (interval && (parser.currentTick - lastCursor) * interval >= 1) {
      lastCursor = parser.currentTick;
      send('cursor');
    }
  });
  parser.gameEvents.on('weapon_fire', (e) => send('weapon_fire', e.weapon, id(e.player?.steamId)));
  parser.gameEvents.on('player_death', (e) =>
    send('player_death', e.weapon, id(e.attackerPlayer?.steamId), id(e.player?.steamId)),
  );
  parser.gameEvents.on('round_start', () => send('round_start'));
  parser.gameEvents.on('round_end', () => send('round_end'));
  return {
    parse: (input: ReadableStream<Uint8Array>) =>
      parser.parseDemo(input, { entities: EntityMode.ALL }),
    cancel: () => parser.cancel(),
  };
}
