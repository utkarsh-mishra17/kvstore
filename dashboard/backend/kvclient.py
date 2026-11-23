"""Minimal client for the KVStore text protocol (used by the FastAPI layer and the test-suite)."""
import json
import socket
import threading
import time


class Reply:
    def __init__(self, lines, meta, ok_transport=True, latency_ms=0.0):
        self.lines = lines
        self.meta = meta
        self.transport_ok = ok_transport
        self.latency_ms = latency_ms

    @property
    def status(self):
        return self.lines[0].split(" ", 1)[0] if self.lines else ""

    @property
    def ok(self):
        return self.transport_ok and bool(self.lines) and self.status != "ERR"

    @property
    def text(self):
        return "\n".join(self.lines)

    def json(self):
        return json.loads(self.lines[0])

    def as_dict(self):
        return {"status": self.status, "ok": self.ok, "lines": self.lines, "meta": self.meta,
                "latency_ms": round(self.latency_ms, 3)}


class KVConn:
    def __init__(self, host="127.0.0.1", port=7070, timeout=15.0, name=None):
        self.sock = socket.create_connection((host, port), timeout=timeout)
        self.sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        self.buf = b""
        if name:
            self.request("HELLO " + name)

    def _readline(self):
        while b"\n" not in self.buf:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise ConnectionError("server closed connection")
            self.buf += chunk
        line, self.buf = self.buf.split(b"\n", 1)
        return line.decode("utf-8", "replace")

    def request(self, cmd) -> Reply:
        t0 = time.perf_counter()
        self.sock.sendall((cmd + "\n").encode())
        lines = []
        while True:
            line = self._readline()
            if line == "END" or line.startswith("END "):
                meta = {}
                for tok in line.split()[1:]:
                    if "=" in tok:
                        k, v = tok.split("=", 1)
                        meta[k] = v
                return Reply(lines, meta, True, (time.perf_counter() - t0) * 1000)
            lines.append(line)

    def close(self):
        try:
            self.sock.close()
        except OSError:
            pass

    def __enter__(self):
        return self

    def __exit__(self, *a):
        self.close()


class ControlConnection:
    """A persistent, auto-reconnecting connection flagged as 'monitor' (hidden from client statistics)."""

    def __init__(self, host="127.0.0.1", port=7070):
        self.host, self.port = host, port
        self.conn = None
        self.lock = threading.Lock()

    def request(self, cmd) -> Reply:
        with self.lock:
            for attempt in range(2):
                try:
                    if self.conn is None:
                        self.conn = KVConn(self.host, self.port, timeout=20.0, name="monitor")
                    return self.conn.request(cmd)
                except (OSError, ConnectionError):
                    if self.conn:
                        self.conn.close()
                    self.conn = None
                    if attempt == 1:
                        raise
        raise ConnectionError("unreachable")

    def available(self):
        try:
            return self.request("PING").status == "PONG"
        except Exception:
            return False
