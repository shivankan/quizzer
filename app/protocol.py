"""Minimal HTTP/1.1 request parsing + RFC6455 WebSocket framing (stdlib only)."""
import asyncio
import base64
import hashlib
import json
import struct

WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"


class HttpRequest:
    def __init__(self, method, path, query, headers, body):
        self.method = method
        self.path = path
        self.query = query
        self.headers = headers      # lower-cased keys
        self.body = body

    @property
    def is_ws_upgrade(self):
        return self.headers.get("upgrade", "").lower() == "websocket"

    def header(self, name, default=None):
        return self.headers.get(name.lower(), default)

    def json(self):
        try:
            return json.loads(self.body.decode("utf-8")) if self.body else {}
        except Exception:
            return {}

    def bearer(self):
        auth = self.headers.get("authorization", "")
        if auth.lower().startswith("bearer "):
            return auth[7:].strip()
        return None


async def read_http_request(reader):
    """Read request line + headers (+ body if Content-Length). Returns HttpRequest or None."""
    try:
        request_line = await reader.readuntil(b"\r\n")
    except (asyncio.IncompleteReadError, asyncio.LimitOverrunError):
        return None
    parts = request_line.decode("latin1").strip().split(" ")
    if len(parts) < 2:
        return None
    method, target = parts[0], parts[1]
    if "?" in target:
        path, _, query = target.partition("?")
    else:
        path, query = target, ""

    headers = {}
    while True:
        line = await reader.readuntil(b"\r\n")
        if line in (b"\r\n", b"\n", b""):
            break
        k, _, v = line.decode("latin1").partition(":")
        headers[k.strip().lower()] = v.strip()

    body = b""
    length = headers.get("content-length")
    if length:
        try:
            body = await reader.readexactly(int(length))
        except (asyncio.IncompleteReadError, ValueError):
            body = b""
    return HttpRequest(method, path, _parse_query(query), headers, body)


def _parse_query(q):
    out = {}
    for pair in q.split("&"):
        if not pair:
            continue
        k, _, v = pair.partition("=")
        out[k] = v
    return out


def ws_accept_key(client_key):
    digest = hashlib.sha1((client_key + WS_GUID).encode()).digest()
    return base64.b64encode(digest).decode()


def ws_handshake_response(client_key):
    accept = ws_accept_key(client_key)
    return (
        "HTTP/1.1 101 Switching Protocols\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        f"Sec-WebSocket-Accept: {accept}\r\n\r\n"
    ).encode()


def encode_frame(data, opcode=0x1):
    """Server->client frame (unmasked). opcode 0x1 text, 0x8 close, 0xA pong."""
    if isinstance(data, str):
        data = data.encode("utf-8")
    length = len(data)
    header = bytearray([0x80 | opcode])
    if length < 126:
        header.append(length)
    elif length < 65536:
        header.append(126)
        header += struct.pack(">H", length)
    else:
        header.append(127)
        header += struct.pack(">Q", length)
    return bytes(header) + data


async def read_frame(reader):
    """Read one client frame. Returns (opcode, payload_bytes) or (None, None) on close/EOF."""
    try:
        b = await reader.readexactly(2)
    except asyncio.IncompleteReadError:
        return None, None
    b0, b1 = b[0], b[1]
    opcode = b0 & 0x0F
    masked = b1 & 0x80
    length = b1 & 0x7F
    try:
        if length == 126:
            length = struct.unpack(">H", await reader.readexactly(2))[0]
        elif length == 127:
            length = struct.unpack(">Q", await reader.readexactly(8))[0]
        mask = await reader.readexactly(4) if masked else b"\x00\x00\x00\x00"
        payload = await reader.readexactly(length) if length else b""
    except asyncio.IncompleteReadError:
        return None, None
    if masked:
        payload = bytes(payload[i] ^ mask[i % 4] for i in range(len(payload)))
    return opcode, payload
