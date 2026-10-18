"""Bounded local parser subprocess. Only validated channel bodies enter this pipe."""
import json
from pathlib import Path
import queue
import subprocess
import threading
from parser_stream import ParserStream
from wire import ProbeError


class ParserBridge:
    def __init__(self, node='node'):
        self._input = queue.Queue(maxsize=4)
        self._output = queue.Queue(maxsize=4096)
        self._failure = None
        self._closed = False
        self._parts = []
        self.sequence = 0
        self.checkpoint = None
        worker = Path(__file__).with_name('parser_worker.mjs')
        self.process = subprocess.Popen([node, str(worker)], stdin=subprocess.PIPE,
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, bufsize=0)
        self.stream = ParserStream(self._parts.append)
        self._writer = threading.Thread(target=self._write, daemon=True)
        self._reader = threading.Thread(target=self._read, daemon=True)
        self._writer.start(); self._reader.start()

    def _write(self):
        try:
            while not self._closed:
                data = self._input.get()
                if data is None:
                    return
                view = memoryview(data)
                while view and not self._closed:
                    count = self.process.stdin.write(view)
                    if not count:
                        raise OSError('parser-pipe-closed')
                    view = view[count:]
        except Exception:
            if not self._closed:
                self._failure = 'parser-input-failed'

    def _read(self):
        try:
            while not self._closed:
                line = self.process.stdout.readline(65537)
                if not line:
                    if not self._closed:
                        self._failure = 'parser-exited'
                    return
                if len(line) > 65536 or not line.endswith(b'\n'):
                    raise ValueError('parser-record-size')
                row = json.loads(line)
                if not isinstance(row, dict) or row.get('type') not in ('event', 'checkpoint'):
                    raise ValueError('parser-terminal-record')
                self._output.put_nowait(row)
        except Exception:
            if not self._closed:
                self._failure = 'parser-output-failed'

    def submit(self, packet):
        self.check()
        self.stream.consume_packet(packet)
        sequence = self.stream.checkpoint()
        data = b''.join(self._parts)
        self._parts.clear()
        if len(data) > 8 * 1024**2:
            raise ProbeError('parser-frame-budget')
        try:
            self._input.put_nowait(data)
        except queue.Full:
            raise ProbeError('parser-input-backpressure') from None
        self.sequence = sequence
        return sequence

    def check(self):
        if self._failure:
            raise ProbeError(self._failure)
        if self._closed or self.process.poll() is not None:
            raise ProbeError('parser-not-running')

    def poll(self, emit):
        self.check()
        while True:
            try:
                row = self._output.get_nowait()
            except queue.Empty:
                return
            if row['type'] == 'event':
                if not isinstance(row.get('event'), dict):
                    raise ProbeError('parser-event-shape')
                emit(row['event'])
            else:
                previous = self.checkpoint['sequence'] if self.checkpoint else 0
                if (type(row.get('sequence')) is not int or row['sequence'] != previous + 1
                    or row['sequence'] > self.sequence
                    or type(row.get('schemaFields')) is not int or row['schemaFields'] < 0
                    or type(row.get('stringTables')) is not int or row['stringTables'] < 0
                    or type(row.get('serverInfo')) is not bool):
                    raise ProbeError('parser-checkpoint-shape')
                self.checkpoint = row

    def close(self):
        if self._closed:
            return
        self._closed = True
        try:
            self._input.put_nowait(None)
        except queue.Full:
            pass
        if self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                self.process.kill(); self.process.wait(timeout=3)
        self._writer.join(timeout=1); self._reader.join(timeout=1)
        self.process.stdin.close(); self.process.stdout.close()
