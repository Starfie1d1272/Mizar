"""Integrated synthetic SDK port. Never generates usable tickets or sends packets."""
import io
import struct
import unittest
from channel import encode_message, join_messages, reliable_frame, decode_frame, messages
from driver import ObserverDriver, DriverError, SampleWriter
from handshake import blob, number, initial_challenge_request
from replay import replay
from wire import fields, scalar, varint


class Port:
    def __init__(self):
        self.state, self.incoming, self.sent, self.closed = 3, [], [], 0
        self.ticket_requested = False
    def remote_id(self): return 456
    def pump(self, now): pass
    def receive(self): return self.incoming.pop(0) if self.incoming else None
    def send(self, data, flags): self.sent.append((data, flags))
    def request_ticket(self): self.ticket_requested = True; self.state = 4
    def with_auth(self, consume): return consume(bytes(8) + b'SYNTHETIC-NOT-A-TICKET')
    def close(self): self.closed += 1; self.state = 6


class DriverTest(unittest.TestCase):
    def ready(self):
        port, output, sample, password = Port(), [], io.BytesIO(), bytearray(b'unit-only')
        driver = ObserverDriver(port, host_version=14191, password=password, emit=output.append,
                                capture=SampleWriter(sample), now_ms=10)
        driver.step(11)
        self.assertEqual(port.sent, [(bytes.fromhex('ffffffff71') + b'connect0x00000000\0', 5)])
        self.assertEqual(port.sent[0][0], initial_challenge_request())
        port.incoming.append((b'\xff\xff\xff\xffA' + struct.pack('<IIHQB', 0, 3, 0, 456, 1) + b'connect0x00000000\0', False))
        driver.step(12)
        self.assertTrue(port.ticket_requested)
        self.assertEqual(len(port.sent), 1)  # No auth/connect before SDK callback gate.
        port.state = 5
        driver.step(13)
        self.assertEqual(port.sent[-1][1], 5)
        data = port.sent[-1][0]
        size, pos = varint(data, 5)
        self.assertEqual(len(data) - pos, size)
        f = fields(data[pos:])
        self.assertEqual(len(scalar(f, 6, 2)), 96)
        self.assertEqual(scalar(f, 8, 2), bytes(8) + b'SYNTHETIC-NOT-A-TICKET')
        self.assertEqual(password, bytes(len(password)))
        self.assertEqual(sample.getvalue(), b'MZRCS2\x01\0')  # No handshake/credentials captured.
        port.incoming.append((b'\xff\xff\xff\xffB\0' + b'0' * 10, False))
        driver.step(14)
        self.assertEqual(driver.phase, 'channel')
        self.assertIsNone(driver.decoder.server)
        self.assertEqual(len(port.sent), 3)
        self.assertEqual(port.sent[-1][1], 8)
        ack = decode_frame(port.sent[-1][0], gns_reliable=True)
        self.assertEqual(ack.reliable_tick_hint, 0)
        decoded, _ = messages(ack.body)
        self.assertEqual([(m.message_id, m.body) for m in decoded],
                         [(7, bytes.fromhex('08 02 10 ff ff ff ff 0f 18 00'))])
        return driver, port, output, sample

    def test_actual_driver_chain_stops_at_new_and_capture_replays(self):
        driver, port, output, sample = self.ready()
        info = number(1, 14191) + number(2, 7) + b'\x6d' + struct.pack('<f', 1 / 64) + blob(15, b'de_test')
        descriptor = blob(1, number(1, 17) + blob(2, b'weapon_fire') + blob(3, number(1, 1) + blob(2, b'weapon')))
        event = number(2, 17) + blob(3, number(1, 1) + blob(2, b'weapon_awp')) + number(4, 100)
        body, _ = join_messages([encode_message(n, b) for n, b in [(40, info), (205, descriptor), (207, event), (7, number(1, 3) + number(2, 7))]])
        port.incoming.append((reliable_frame(body, 0), True))
        driver.step(20)
        self.assertEqual((driver.phase, driver.reason), ('blocked', 'client-initialization-required'))
        self.assertEqual(len(port.sent), 3)  # q, connect, CONNECTED; no unimplemented NEW ACK.
        self.assertEqual(output[0]['weapon'], 'weapon_awp')
        self.assertEqual(driver.report()['online_success'], 'INCONCLUSIVE')
        self.assertNotIn('SYNTHETIC', str(driver.report()))
        sample.seek(0)
        replayed = []
        report = replay(sample, replayed.append)
        self.assertEqual(output, replayed)
        self.assertEqual(report['frames'], 1)
        driver.close()
        self.assertEqual(port.closed, 1)

    def test_wrong_peer_context_and_timeouts_do_not_request_ticket(self):
        for server, context, expected in [(999, b'connect0x00000000', 'peer-mismatch'), (456, b'wrong', 'context-mismatch')]:
            port = Port()
            driver = ObserverDriver(port, host_version=14191, password=bytearray(), emit=lambda _: None)
            driver.step(1)
            port.incoming.append((b'\xff\xff\xff\xffA' + struct.pack('<IIHQB', 0, 3, 0, server, 1) + context + b'\0', False))
            with self.assertRaisesRegex(DriverError, expected): driver.step(2)
            self.assertFalse(port.ticket_requested)
            driver.close()
        port = Port()
        driver = ObserverDriver(port, host_version=14191, password=bytearray(), emit=lambda _: None)
        driver.step(1)
        with self.assertRaisesRegex(DriverError, 'phase-timeout'): driver.step(15001)
        driver.close()
        self.assertEqual(len(port.sent), 1)

    def test_no_auth_sample_and_truncated_sample_rejected(self):
        writer = SampleWriter(io.BytesIO())
        with self.assertRaises(ValueError): writer(b'\xff\xff\xff\xffkSECRET', False, 0)
        with self.assertRaisesRegex(ValueError, 'truncated-header'):
            replay(io.BytesIO(b'MZRCS2\x01\0x'), lambda _: None)
        driver, _, _, _ = self.ready()
        with self.assertRaisesRegex(DriverError, 'monotonic-clock-regressed'): driver.step(1)
        driver.close()


if __name__ == '__main__': unittest.main(verbosity=2)
