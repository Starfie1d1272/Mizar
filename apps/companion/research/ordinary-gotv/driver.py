#!/usr/bin/env python3
"""Explicit local ordinary-viewer research driver. Never invoked by import/tests.

Native SDK authentication -> actual first q -> validated challenge -> callback-gated
user ticket -> known-password connect -> channel receive -> live message consumer.
Stops at missing initialization; no synthetic NEW/SPAWN acknowledgement is sent.
"""
import argparse
import getpass
import ipaddress
import json
import os
from pathlib import Path
import struct
import sys
import time
from channel import decode_frame, messages, UnreliableOrder
from handshake import (SignonSequence, connect_inner_message, connect_payload,
                       initial_challenge_request, parse_challenge_body, parse_connection_inner, uint)
from live import LiveDecoder
from password import transform_password
from wire import ProbeError

MAGIC = b'MZRCS2\x01\0'


class DriverError(Exception):
    pass


class ObserverDriver:
    """One session/one receiver. Port is sdk.NativePort in the real invocation.

    Tests use a clearly synthetic port. No success flag can be set by either port.
    Configured source version must match the source, not merely this binary sample.
    """
    def __init__(self, port, *, host_version, password, emit, capture=None, now_ms=0):
        uint(host_version)
        if not host_version or not isinstance(password, bytearray) or len(password) > 95 or 0 in password:
            raise DriverError('configuration-boundary')
        self.port, self.host_version = port, host_version
        self._password = password  # Ownership transferred; wiped on connect/close.
        self._challenge = None
        self.decoder, self.signon = LiveDecoder(emit), SignonSequence()
        self.order = UnreliableOrder(initial=0)
        self.capture = capture
        self.phase, self.reason = 'transport', None
        self.start_ms, self.last_ms, self.deadline = now_ms, now_ms, now_ms + 30000
        self.received, self.channel_frames, self.channel_bytes = 0, 0, 0
        self.first_channel_ms = self.last_channel_ms = None
        self.stages = [{'stage': 'transport', 'elapsed_ms': 0}]
        self.native_state = None

    @property
    def done(self):
        return self.phase in ('blocked', 'closed')

    def step(self, now_ms):
        if self.done:
            return
        if now_ms < self.last_ms:
            raise DriverError('monotonic-clock-regressed')
        self.last_ms = now_ms
        if now_ms >= self.deadline:
            raise DriverError('phase-timeout')
        self.port.pump(now_ms)
        if self.port.state != self.native_state:
            self.native_state = self.port.state
            self.stages.append({'stage': 'sdk-state', 'value': self.native_state, 'elapsed_ms': now_ms - self.start_ms})
        if self.port.state == 6:
            raise DriverError('native-session-closed')
        if self.phase == 'transport' and self.port.state == 3:
            if not self.port.remote_id():
                raise DriverError('trusted-peer-missing')
            self.port.send(initial_challenge_request(), 5)
            self.phase, self.deadline = 'challenge', now_ms + 15000
            self.stages.append({'stage': self.phase, 'elapsed_ms': now_ms - self.start_ms})
        if self.phase == 'ticket' and self.port.state == 5:
            self.port.with_auth(self._send_connect)
            self.phase, self.deadline = 'connection', now_ms + 15000
            self.stages.append({'stage': self.phase, 'elapsed_ms': now_ms - self.start_ms})
        for _ in range(128):  # Bound work per callback pump; do not starve deadlines.
            message = self.port.receive()
            if message is None:
                break
            self.received += 1
            self.receive(*message, now_ms)
            if self.done:
                break

    def _send_connect(self, auth):
        try:
            payload = connect_payload(host_version=self.host_version, challenge=self._challenge,
                auth_steam=auth, player_name='Mizar observer',
                encrypted_password=transform_password(bytes(self._password), self._challenge.number),
                reservation_cookie=0, low_violence=False)
            self.port.send(connect_inner_message(payload), 5)
        finally:
            self._password[:] = bytes(len(self._password))

    def receive(self, data, reliable, now_ms):
        if self.phase == 'challenge':
            if reliable or not data.startswith(b'\xff\xff\xff\xffA'):
                raise DriverError('unexpected-challenge-message')
            challenge = parse_challenge_body(data[5:])
            if challenge.server_steam_id != self.port.remote_id() or not challenge.server_steam_id:
                raise DriverError('challenge-peer-mismatch')
            if challenge.context != b'connect0x00000000':
                raise DriverError('challenge-context-mismatch')
            self._challenge = challenge
            self.port.request_ticket()
            self.phase, self.deadline = 'ticket', now_ms + 30000
            self.stages.append({'stage': self.phase, 'elapsed_ms': now_ms - self.start_ms})
            return
        if self.phase == 'connection':
            if reliable:
                raise DriverError('unexpected-connection-reliability')
            response = parse_connection_inner(data)
            if response['addon_name_bytes']:
                self.phase, self.reason = 'blocked', 'addon-initialization-required'
                return
            self.phase, self.deadline = 'channel', now_ms + 15000
            self.stages.append({'stage': self.phase, 'elapsed_ms': now_ms - self.start_ms})
            self._challenge = None
            return
        if self.phase != 'channel':
            raise DriverError('unexpected-protocol-phase')
        frame = decode_frame(data, gns_reliable=reliable)
        # Never save handshake/tickets/passwords. Only validated channel envelopes
        # reach capture, before order filtering, so duplicates can be reproduced.
        if self.capture is not None:
            self.capture(data, reliable, now_ms - self.start_ms)
        self.channel_frames += 1
        self.channel_bytes += len(data)
        if self.first_channel_ms is None:
            self.first_channel_ms = now_ms
        self.last_channel_ms, self.deadline = now_ms, now_ms + 15000
        if not reliable and not self.order.accept(frame)['accepted']:
            return
        decoded, _ = messages(frame.body)
        for message in decoded:
            if message.message_id == 7:
                self.signon.receive(message.body)
                self.stages.append({'stage': 'received-signon', 'value': self.signon.state, 'elapsed_ms': now_ms - self.start_ms})
            else:
                self.decoder.consume(message.message_id, message.body)
                if message.message_id == 40:
                    self.signon.server_info(self.decoder.server['server_count'])
        if self.signon.state >= 3:
            self.phase, self.reason = 'blocked', 'client-initialization-required'

    def report(self):
        span = None if self.first_channel_ms is None else self.last_channel_ms - self.first_channel_ms
        return {'phase': self.phase, 'reason': self.reason, 'received_messages': self.received,
                'channel_frames': self.channel_frames, 'channel_bytes': self.channel_bytes,
                'channel_receive_span_ms': span, 'received_signon_state': self.signon.state,
                'stages': self.stages,
                'net_message_counts': self.decoder.counts, 'initialization_blockers': self.decoder.blockers(),
                'ordinary_viewer_handshake': 'INCONCLUSIVE', 'live_continuous_receipt': 'INCONCLUSIVE',
                'online_success': 'INCONCLUSIVE'}

    def close(self):
        self._password[:] = bytes(len(self._password))
        self._challenge = None
        self.port.close()


def private_file(path, mode):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    return os.fdopen(fd, mode)


class SampleWriter:
    """Private local channel sample, no endpoint/handshake/auth or packet printouts."""
    def __init__(self, handle):
        self.handle = handle
        handle.write(MAGIC)

    def __call__(self, data, reliable, elapsed_ms):
        decode_frame(data, gns_reliable=reliable)  # Reject all connectionless/auth inputs.
        self.handle.write(struct.pack('<IQB', len(data), elapsed_ms, int(reliable)) + data)


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--native', type=Path, required=True)
    ap.add_argument('--steam-api', type=Path)
    ap.add_argument('--host-version', type=int, required=True)
    ap.add_argument('--output', type=Path, required=True)
    ap.add_argument('--seconds', type=int, default=300, choices=range(1, 14401), metavar='1..14400')
    ap.add_argument('--offset', type=int, default=120, choices=range(0, 3601), metavar='0..3600')
    args = ap.parse_args()
    # Source and known password are local prompts, not process arguments/log files.
    endpoint = getpass.getpass('Authorized GOTV numeric IP:port (hidden): ')
    address, separator, port_text = endpoint.rpartition(':')
    try:
        ipaddress.ip_address(address.strip('[]'))
        if not separator or not 0 < int(port_text) < 65536:
            raise ValueError()
    except ValueError:
        raise SystemExit('invalid-numeric-endpoint') from None
    supplied = getpass.getpass('Existing ordinary spectator password (ASCII subset, hidden): ')
    try:
        password = bytearray(supplied.encode('ascii'))
    except UnicodeError:
        raise SystemExit('non-ascii-password-requires-verified-source-encoding') from None
    del supplied
    if not 0 < args.host_version <= 0xffffffff or len(password) > 95 or 0 in password:
        password[:] = bytes(len(password))
        raise SystemExit('configuration-boundary')
    args.output.mkdir(mode=0o700)
    driver = native = events = samples = None
    report, failure = {'online_success': 'INCONCLUSIVE', 'offset_seconds': args.offset}, None
    finalization = []
    def clock(): return time.monotonic_ns() // 1000000
    try:
        from sdk import NativePort, NativeStartError
        events = private_file(args.output / 'events.jsonl', 'w')
        samples = private_file(args.output / 'channel.frames', 'wb')
        native = NativePort(args.native, endpoint, clock(), steam_api=args.steam_api)
        del endpoint
        driver = ObserverDriver(native, host_version=args.host_version, password=password,
            emit=lambda event: events.write(json.dumps(event) + '\n'), capture=SampleWriter(samples), now_ms=clock())
        stop = clock() + args.seconds * 1000
        while not driver.done and clock() < stop:
            driver.step(clock())
            time.sleep(.01)
        if not driver.done:
            driver.reason = 'duration-limit-incomplete'
        report.update(driver.report())
    except BaseException as error:
        # Never print exception text/tracebacks: SDK/source/password data may be present.
        failure = str(error) if type(error) is DriverError else 'interrupted' if isinstance(error, KeyboardInterrupt) else 'operation-failed-details-omitted'
        if type(error).__name__ == 'NativeStartError':
            failure = 'native-start-failed'
            report['native_boot_code'], report['steam_init_result'] = error.boot_code, error.init_result
        if driver is not None:
            report.update(driver.report())
        report.update(outcome='failed', reason=failure)
    finally:
        password[:] = bytes(len(password))
        for stage, action in [('close-session', driver.close if driver else native.close if native else None),
                              ('close-events', events.close if events else None),
                              ('close-samples', samples.close if samples else None)]:
            if action:
                try: action()
                except BaseException: finalization.append(stage)
        report['finalization_failures'] = finalization
        report['outcome'] = 'failed' if failure or finalization else 'incomplete'
        report['report_written'] = False
        try:
            with private_file(args.output / 'report.json', 'w') as handle:
                # stdout is the final authority for report-written status after close.
                json.dump(report, handle, indent=2); handle.write('\n')
            report['report_written'] = True
        except BaseException:
            report['finalization_failures'].append('write-report')
            report['outcome'] = 'failed'
        print(json.dumps(report), file=sys.stderr if report['outcome'] == 'failed' else sys.stdout)
    return 1 if report['outcome'] == 'failed' else 2


if __name__ == '__main__':
    raise SystemExit(main())
