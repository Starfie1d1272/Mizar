"""Source 2 net-message consumer. No Demo wrapper, auth bytes, sockets or init ACKs.

The historical Source1Legacy names below are messages in CS2's gameevents.proto;
this does not import Source 1 transport. Player identity/entity state stay unknown.
"""
import math
import struct
from handshake import number, uint
from wire import fields, scalar, varint, ProbeError

EVENTS = {'weapon_fire', 'player_death', 'round_start', 'round_end'}


def repeated(f, tag, wire=2):
    values = f.get(tag, [])
    if any(kind != wire for kind, _ in values):
        raise ProbeError('live-repeated-wire')
    return [value for _, value in values]


def text(value, maximum=256):
    if not isinstance(value, bytes) or not value or len(value) > maximum or b'\0' in value:
        raise ProbeError('live-text-boundary')
    try:
        return value.decode('utf8')
    except UnicodeError:
        raise ProbeError('live-text-encoding') from None


def int32(value):
    if value is None:
        return None
    value &= 0xffffffff
    return value - 0x100000000 if value & 0x80000000 else value


def client_info(*, server_count, send_table_crc, account_id):
    """Encoding only. CRC must come from a verified initializer, never a placeholder.

    The driver deliberately does not call this until that initializer exists.
    is_hltv=false is the ordinary-client field, not a relay-authorization bypass.
    """
    return b'\x0d' + uint(send_table_crc).to_bytes(4, 'little') + number(2, server_count) + number(3, 0) + number(5, account_id)


class LiveDecoder:
    def __init__(self, emit):
        self.emit = emit
        self.tick = None
        self.server = None
        self.descriptors = {}
        self.serializers = set()
        self.classes = {}
        self.tables = []
        self.entity_packets = 0
        self.counts = {}
        self.unresolved_events = 0

    def blockers(self):
        # Presence is not initialization. This API offers no caller-controlled ready flag.
        return ['client-send-table-crc', 'serializer-field-decoders',
                'string-table-callbacks-and-baselines', 'session-manifest-and-spawn-groups',
                'entity-full-snapshot']

    def consume(self, message_id, body):
        self.counts[message_id] = self.counts.get(message_id, 0) + 1
        if message_id not in (4, 40, 41, 42, 44, 45, 51, 55, 205, 207):
            return
        f = fields(body, limit=4 * 1024**2)
        if message_id == 4:
            tick = scalar(f, 1)
            if tick is None or tick > 0x7fffffff or (self.tick is not None and tick < self.tick):
                raise ProbeError('live-tick-regressed-or-missing')
            self.tick = tick
        elif message_id == 40:
            count, protocol = scalar(f, 2), scalar(f, 1)
            interval = scalar(f, 13, 5)
            if count is None or protocol is None or interval is None:
                raise ProbeError('live-serverinfo-required-field')
            interval = struct.unpack('<f', interval)[0]
            info = {'server_count': uint(count), 'protocol': uint(protocol),
                    'map': text(scalar(f, 15, 2)), 'tick_interval': interval}
            if not math.isfinite(interval) or not 0 < interval <= 1:
                raise ProbeError('live-tick-interval')
            if self.server is not None and self.server != info:
                raise ProbeError('live-serverinfo-changed-new-instance-required')
            self.server = info
        elif message_id == 41:
            symbols = [text(value, 1024) for value in repeated(f, 2)]
            definitions = repeated(f, 3)
            serializers = set()
            for raw in repeated(f, 1):
                s = fields(raw)
                index, version = scalar(s, 1), scalar(s, 2)
                if index is None or index >= len(symbols) or version is None:
                    raise ProbeError('serializer-symbol-boundary')
                key = (symbols[index], int32(version))
                if key in serializers:
                    raise ProbeError('serializer-duplicate')
                serializers.add(key)
                for wire, value in s.get(3, []):
                    indices = []
                    if wire == 0:
                        indices.append(value)
                    elif wire == 2:
                        pos = 0
                        while pos < len(value):
                            item, pos = varint(value, pos)
                            indices.append(item)
                    else:
                        raise ProbeError('serializer-index-wire')
                    if any(item >= len(definitions) for item in indices):
                        raise ProbeError('serializer-field-boundary')
            self.serializers = serializers  # Valid references, NOT executable entity decoders.
        elif message_id == 42:
            classes = {}
            for raw in repeated(f, 2):
                c = fields(raw)
                index = scalar(c, 1)
                if index is None or index > 65535 or index in classes:
                    raise ProbeError('class-index-boundary')
                classes[index] = text(scalar(c, 3, 2))
            self.classes = classes
        elif message_id == 44:
            if len(self.tables) >= 1024:
                raise ProbeError('string-table-count-budget')
            self.tables.append({'name': text(scalar(f, 1, 2)), 'decoded': False})
        elif message_id == 45:
            index = scalar(f, 1)
            if index is None or index >= len(self.tables):
                raise ProbeError('string-table-update-before-create')
        elif message_id == 51:
            self.tables.clear()
        elif message_id == 55:
            self.entity_packets += 1  # Opaque; receiving this does not establish a baseline.
        elif message_id == 205:
            descriptors = {}
            for raw in repeated(f, 1):
                d = fields(raw)
                event_id = scalar(d, 1)
                if event_id is None or event_id > 65535 or event_id in descriptors:
                    raise ProbeError('event-descriptor-id')
                keys = []
                for key in repeated(d, 3):
                    k = fields(key)
                    kind, name = scalar(k, 1), text(scalar(k, 2, 2))
                    if kind is None or kind > 0x7fffffff or name in [name for _, name in keys]:
                        raise ProbeError('event-descriptor-key')
                    keys.append((kind, name))
                descriptors[event_id] = (text(scalar(d, 2, 2)), keys)
            self.descriptors = descriptors
        elif message_id == 207:
            self.event(f)

    def event(self, f):
        descriptor = self.descriptors.get(scalar(f, 2))
        if descriptor is None:
            self.unresolved_events += 1
            return  # No bundled/hard-coded event IDs or speculative name-only decode.
        name, keys = descriptor
        if name not in EVENTS:
            return
        supplied_name = scalar(f, 1, 2)
        if supplied_name is not None and text(supplied_name) != name:
            raise ProbeError('event-name-mismatch')
        values = repeated(f, 3)
        if len(values) != len(keys):
            raise ProbeError('event-key-count')
        weapon = None
        for (kind, key), raw in zip(keys, values):
            value = fields(raw)
            if scalar(value, 1) != kind:
                raise ProbeError('event-key-type')
            # Only the intended output scalar is retained; no arbitrary strings/IDs.
            if key == 'weapon':
                if kind != 1:
                    raise ProbeError('event-weapon-type')
                weapon = text(scalar(value, 2, 2), 128)
        event_tick = int32(scalar(f, 4))
        if event_tick is not None and event_tick < 0:
            event_tick = None
        tick = event_tick if event_tick is not None else self.tick
        self.emit({'kind': name, 'tick': tick,
                   'tick_source': 'event.server_tick' if event_tick is not None else 'net_Tick' if tick is not None else None,
                   'weapon': weapon, 'map': self.server['map'] if self.server else None,
                   'tick_interval': self.server['tick_interval'] if self.server else None,
                   'actor': None, 'target': None, 'warmup': None, 'round': None,
                   'online_success': 'INCONCLUSIVE'})
