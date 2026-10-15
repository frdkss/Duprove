"""Small WSGI ingestion API. Production entry point is behind the HTTPS proxy."""
from http import HTTPStatus
import json
import re
import sqlite3
import threading
import time

from .contract import is_report
from .settings import Settings
from .storage import StorageFull, Store


class InvalidJSON(ValueError):
    pass


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise InvalidJSON()
        result[key] = value
    return result


def invalid_constant(_value):
    raise InvalidJSON()


def parse_report(raw):
    # Bound depth before entering the recursive JSON decoder or schema validator.
    depth = 0
    quoted = escaped = False
    for char in raw:
        if quoted:
            if escaped:
                escaped = False
            elif char == 92:
                escaped = True
            elif char == 34:
                quoted = False
        elif char == 34:
            quoted = True
        elif char in (91, 123):
            depth += 1
            if depth > 16:
                raise InvalidJSON()
        elif char in (93, 125):
            depth -= 1
    value = json.loads(raw.decode('utf-8'), object_pairs_hook=unique_object,
                       parse_constant=invalid_constant)
    # Reject lone surrogates, which cannot be canonical UTF-8 on disk.
    canonical = json.dumps(value, ensure_ascii=False, allow_nan=False,
                           separators=(',', ':'), sort_keys=True).encode('utf-8')
    return value, canonical


class RateLimiter:
    def __init__(self, settings, clock=time.monotonic):
        self.clock = clock
        self.rate = settings.requests_per_minute / 60
        self.capacity = settings.burst
        self.tokens = float(self.capacity)
        self.updated = clock()
        self.lock = threading.Lock()

    def allow(self):
        with self.lock:
            now = self.clock()
            self.tokens = min(self.capacity, self.tokens + max(0, now - self.updated) * self.rate)
            self.updated = now
            if self.tokens < 1:
                return False
            self.tokens -= 1
            return True


class Application:
    def __init__(self, settings: Settings, store=None):
        self.settings = settings
        self.store = store if store is not None else Store(settings)
        self.limiter = RateLimiter(settings)

    def __call__(self, environ, start_response):
        try:
            status, body, headers = self.handle(environ)
        except (StorageFull, sqlite3.Error, OSError, TimeoutError):
            status, body, headers = 503, {'accepted': False, 'error': 'storage_unavailable'}, [('Retry-After', '60')]
        except Exception:
            # Never reflect/log validator errors, request data or filesystem paths.
            status, body, headers = 500, {'accepted': False, 'error': 'internal_error'}, []
        raw = json.dumps(body, separators=(',', ':')).encode('ascii')
        start_response(f'{status} {HTTPStatus(status).phrase}', [
            ('Content-Type', 'application/json'), ('Content-Length', str(len(raw))),
            ('Cache-Control', 'no-store'), ('X-Content-Type-Options', 'nosniff'), *headers])
        return [raw]

    def handle(self, env):
        def error(status, code, headers=None):
            return status, {'accepted': False, 'error': code}, headers or []

        path, method = env.get('PATH_INFO', ''), env.get('REQUEST_METHOD', '')
        if env.get('QUERY_STRING'):
            return error(400, 'query_not_allowed')
        if path == '/healthz':
            if method != 'GET':
                return error(405, 'method_not_allowed', [('Allow', 'GET')])
            return (200, {'status': 'ok'}, []) if self.store.healthy() else error(503, 'storage_unavailable')
        if path != '/v1/reports':
            return error(404, 'not_found')
        if method != 'POST':
            return error(405, 'method_not_allowed', [('Allow', 'POST')])
        if not self.limiter.allow():
            return error(429, 'rate_limited', [('Retry-After', '60')])
        if env.get('HTTP_CONTENT_ENCODING', 'identity').lower() != 'identity':
            return error(415, 'unsupported_encoding')
        if not re.fullmatch(r'application/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?',
                            env.get('CONTENT_TYPE', ''), re.IGNORECASE):
            return error(415, 'unsupported_media_type')
        if env.get('HTTP_TRANSFER_ENCODING'):
            return error(400, 'unsupported_transfer_encoding')
        length = env.get('CONTENT_LENGTH', '')
        if not length:
            return error(411, 'length_required')
        if not re.fullmatch('[0-9]{1,10}', length):
            return error(400, 'invalid_length')
        length = int(length)
        if length > self.settings.max_request_bytes:
            return error(413, 'request_too_large')
        deadline = time.monotonic() + self.settings.processing_seconds
        raw = env['wsgi.input'].read(length)
        if len(raw) != length:
            return error(400, 'incomplete_body')
        try:
            report, canonical = parse_report(raw)
            valid = is_report(report)
        except (ValueError, RecursionError, OverflowError):
            return error(400, 'invalid_json')
        if not valid:
            return error(422, 'invalid_report')
        if time.monotonic() >= deadline:
            return error(503, 'processing_timeout', [('Retry-After', '60')])
        receipt = self.store.save(canonical, deadline)
        return 201, {'accepted': True, 'receipt_id': receipt}, []
