import concurrent.futures
from dataclasses import replace
import io
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import Mock, call, patch
from uuid import uuid4
import urllib.error
import urllib.request
from wsgiref.simple_server import make_server, WSGIRequestHandler

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'backend'))
from duprove_backend.server import Application, RateLimiter
from duprove_backend import maintenance
from duprove_backend.settings import Settings
from duprove_backend.storage import StorageFull, Store

EXAMPLE = json.loads((ROOT / 'contracts/fixtures/example.json').read_text(encoding='utf-8'))
PAYLOAD = json.dumps(EXAMPLE).encode('utf-8')


def request(app, body=PAYLOAD, **overrides):
    env = {'PATH_INFO': '/v1/reports', 'REQUEST_METHOD': 'POST',
           'CONTENT_TYPE': 'application/json', 'CONTENT_LENGTH': str(len(body)),
           'wsgi.input': io.BytesIO(body)}
    env.update(overrides)
    result = {}

    def start(status, headers):
        result['status'] = int(status.split()[0])
        result['headers'] = dict(headers)

    result['body'] = json.loads(b''.join(app(env, start)))
    return result


class ServerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.settings = Settings(Path(self.temp.name) / 'reports.sqlite3', burst=500)
        self.app = Application(self.settings)

    def rows(self):
        with self.app.store.connection() as db:
            return db.execute('SELECT id, received_at, payload FROM reports').fetchall()

    def test_all_shared_contract_cases_over_api(self):
        cases = json.loads((ROOT / 'contracts/fixtures/cases.json').read_text(encoding='utf-8'))
        for case in cases:
            with self.subTest(case=case['name']):
                response = request(self.app, json.dumps(case['report']).encode())
                self.assertEqual(response['status'], 201 if case['valid'] else 422)
        self.assertEqual(len(self.rows()), sum(c['valid'] for c in cases))

    def test_stores_only_report_and_server_receipt_after_commit(self):
        response = request(self.app, HTTP_X_FORWARDED_FOR='PRIVATE_IP', HTTP_COOKIE='PRIVATE_COOKIE',
                           HTTP_USER_AGENT='PRIVATE_AGENT', REMOTE_ADDR='PRIVATE_IP')
        self.assertEqual(response['status'], 201)
        self.assertTrue(response['body']['accepted'])
        reopened = Store(self.settings)
        with reopened.connection() as db:
            receipt, received, payload = db.execute('SELECT * FROM reports').fetchone()
        self.assertEqual(json.loads(payload), EXAMPLE)
        self.assertEqual(receipt, response['body']['receipt_id'])
        self.assertLess(abs(received - time.time()), 5)
        self.assertNotIn(b'PRIVATE', self.settings.database.read_bytes())
        self.assertEqual(response['headers']['Cache-Control'], 'no-store')

    def test_malformed_json_is_not_stored_or_logged(self):
        samples = [b'', b'{', b'null', b'[]', b'NaN', b'Infinity', b'{"x":1,"x":2}',
                   b'[' * 1000 + b']' * 1000, b'"\xff"', b'{"x":"\\ud800"}', b'{"x":1e999}',
                   b'{"path":"PRIVATE_FILE"}', b'"PRIVATE_FILE"']
        with patch('sys.stdout', new_callable=io.StringIO) as out, patch('sys.stderr', new_callable=io.StringIO) as err:
            for sample in samples:
                with self.subTest(sample=sample[:50]):
                    response = request(self.app, sample)
                    self.assertIn(response['status'], (400, 422))
                    self.assertNotIn('PRIVATE', json.dumps(response))
        self.assertEqual(out.getvalue() + err.getvalue(), '')
        self.assertEqual(self.rows(), [])

    def test_protocol_errors(self):
        cases = [(404, {'PATH_INFO': '/PRIVATE_FILE'}), (405, {'REQUEST_METHOD': 'GET'}),
                 (400, {'QUERY_STRING': 'file=PRIVATE_FILE'}),
                 (415, {'CONTENT_TYPE': 'text/plain'}), (415, {'HTTP_CONTENT_ENCODING': 'gzip'}),
                 (411, {'CONTENT_LENGTH': ''}), (400, {'CONTENT_LENGTH': '-1'}),
                 (400, {'CONTENT_LENGTH': '1,2'}), (400, {'HTTP_TRANSFER_ENCODING': 'chunked'}),
                 (400, {'CONTENT_LENGTH': str(len(PAYLOAD) + 1)}),
                 (413, {'CONTENT_LENGTH': str(self.settings.max_request_bytes + 1)})]
        for expected, fields in cases:
            with self.subTest(fields=fields):
                response = request(self.app, **fields)
                self.assertEqual(response['status'], expected)
                self.assertNotIn('PRIVATE', json.dumps(response))
        self.assertEqual(self.rows(), [])
        self.assertEqual(request(self.app, CONTENT_TYPE='application/json; charset="UTF-8"')['status'], 201)

    def test_size_rejected_without_reading(self):
        stream = io.BytesIO(PAYLOAD)
        response = request(self.app, CONTENT_LENGTH='99999999', **{'wsgi.input': stream})
        self.assertEqual(response['status'], 413)
        self.assertEqual(stream.tell(), 0)

    def test_actual_body_limit_and_exact_boundary(self):
        self.app = Application(replace(self.settings, max_request_bytes=len(PAYLOAD)))
        self.assertEqual(request(self.app)['status'], 201)
        self.assertEqual(request(self.app, PAYLOAD + b' ')['status'], 413)

    def test_rate_limit_and_refill(self):
        clock = [0.0]
        limiter = RateLimiter(replace(self.settings, burst=2, requests_per_minute=6), lambda: clock[0])
        self.app.limiter = limiter
        self.assertEqual(request(self.app)['status'], 201)
        self.assertEqual(request(self.app)['status'], 201)
        result = request(self.app)
        self.assertEqual(result['status'], 429)
        self.assertEqual(result['headers']['Retry-After'], '60')
        clock[0] = 10
        self.assertEqual(request(self.app)['status'], 201)

    def test_report_count_quota_and_retention_recovers_capacity(self):
        settings = replace(self.settings, max_reports=1, retention_seconds=10)
        self.app = Application(settings)
        self.assertEqual(request(self.app)['status'], 201)
        self.assertEqual(request(self.app)['status'], 503)
        self.assertEqual(len(self.rows()), 1)
        received = self.rows()[0][1]
        self.assertEqual(self.app.store.prune(now=received + 9), 0)
        self.assertEqual(self.app.store.prune(now=received + 10), 1)
        with self.app.store.connection() as db:
            self.assertEqual(db.execute('SELECT reports,bytes FROM usage').fetchone(), (0, 0))
        self.assertEqual(request(self.app)['status'], 201)

    def test_payload_and_physical_database_quotas(self):
        self.app = Application(replace(self.settings, max_payload_bytes=1))
        self.assertEqual(request(self.app)['status'], 503)
        self.assertEqual(self.rows(), [])
        store = Store(replace(self.settings, max_database_bytes=65536))
        with self.assertRaises(sqlite3.DatabaseError):
            store.save(b'x' * 100000, time.monotonic() + 5)
        self.assertLessEqual(self.settings.database.stat().st_size, 65536)
        self.assertEqual(self.rows(), [])
        self.assertEqual(list(Path(self.temp.name).glob('*-journal')), [])

    def test_concurrent_quota_is_atomic(self):
        self.app = Application(replace(self.settings, max_reports=3))
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(lambda _: request(self.app), range(12)))
        self.assertEqual(sum(r['status'] == 201 for r in results), 3)
        self.assertTrue(all(r['status'] in (201, 503) for r in results))
        self.assertEqual(len(self.rows()), 3)
        with self.app.store.connection() as db:
            self.assertEqual(db.execute('SELECT reports,bytes FROM usage').fetchone(),
                             (3, sum(len(row[2]) for row in self.rows())))

    def test_expired_rows_are_erased_without_incoming_requests(self):
        store = self.app.store
        deadline = time.monotonic() + 5
        store.save(b'PRIVATE_EXPIRED', deadline, now=1)
        store.save(b'current', deadline, now=self.settings.retention_seconds + 2)
        self.assertEqual(store.prune(now=self.settings.retention_seconds + 1), 1)
        self.assertEqual([row[2] for row in self.rows()], [b'current'])
        self.assertNotIn(b'PRIVATE_EXPIRED', self.settings.database.read_bytes())

    def test_storage_failure_and_deadline_never_report_success(self):
        for exception in (StorageFull(), OSError('PRIVATE_PATH'), sqlite3.OperationalError('PRIVATE_SQL')):
            with patch.object(self.app.store, 'save', side_effect=exception):
                result = request(self.app)
            self.assertEqual(result['status'], 503)
            self.assertFalse(result['body']['accepted'])
            self.assertNotIn('PRIVATE', json.dumps(result))
        # Windows monotonic clocks may not tick during a short request. Advance
        # the clock explicitly instead of relying on a nanosecond deadline.
        with patch('duprove_backend.server.time.monotonic',
                   side_effect=[100, 100 + self.settings.processing_seconds + 1]):
            result = request(self.app)
        self.assertEqual(result['status'], 503)
        self.assertEqual(result['body']['error'], 'processing_timeout')
        with self.assertRaises(TimeoutError):
            self.app.store.save(PAYLOAD, deadline=time.monotonic() - 1)
        self.assertEqual(self.rows(), [])

    def test_health_and_no_download_endpoint(self):
        self.assertEqual(request(self.app, PATH_INFO='/healthz', REQUEST_METHOD='GET')['status'], 200)
        self.assertEqual(request(self.app, REQUEST_METHOD='GET')['status'], 405)
        self.assertEqual(request(self.app, PATH_INFO='/reports.sqlite3', REQUEST_METHOD='GET')['status'], 404)

    def test_idempotent_retry_survives_restart_and_full_quota(self):
        self.app = Application(replace(self.settings, max_reports=1))
        key = str(uuid4())
        first = request(self.app, HTTP_IDEMPOTENCY_KEY=key)
        self.assertEqual(first['status'], 201)
        original = self.rows()
        self.app = Application(replace(self.settings, max_reports=1))
        repeated = request(self.app, HTTP_IDEMPOTENCY_KEY=key)
        self.assertEqual(repeated['status'], 201)
        self.assertEqual(repeated['body'], first['body'])
        self.assertEqual(repeated['body']['receipt_id'], key)
        self.assertEqual(self.rows(), original, 'A retry must not renew retention or consume quota')
        self.assertEqual(request(self.app, HTTP_IDEMPOTENCY_KEY=str(uuid4()))['status'], 503)

    def test_concurrent_idempotency_and_conflicting_payload(self):
        key = str(uuid4())
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(lambda _: request(self.app, HTTP_IDEMPOTENCY_KEY=key), range(8)))
        self.assertTrue(all(r['status'] == 201 for r in results))
        self.assertEqual(len(self.rows()), 1)
        changed = dict(EXAMPLE, complete=not EXAMPLE['complete'])
        result = request(self.app, json.dumps(changed).encode(), HTTP_IDEMPOTENCY_KEY=key)
        self.assertEqual(result['status'], 409)
        self.assertFalse(result['body']['accepted'])
        self.assertEqual(len(self.rows()), 1)
        self.assertEqual(json.loads(self.rows()[0][2]), EXAMPLE)
        self.assertEqual(request(self.app, HTTP_IDEMPOTENCY_KEY=str(uuid4()))['status'], 201)
        self.assertEqual(len(self.rows()), 2, 'Identical reports from distinct analyses remain independent')

    def test_invalid_idempotency_key_is_not_stored_or_reflected(self):
        for key in ['', 'PRIVATE_PATH', str(uuid4()).upper(), str(uuid4()) + ', ' + str(uuid4())]:
            result = request(self.app, HTTP_IDEMPOTENCY_KEY=key)
            self.assertEqual(result['status'], 400)
            if key:
                self.assertNotIn(key, json.dumps(result))
        self.assertEqual(self.rows(), [])

    def test_retention_retries_startup_failure_without_logging_exception(self):
        for failure in (OSError('PRIVATE_PATH'), sqlite3.OperationalError('PRIVATE_SQL'), StorageFull()):
            with self.subTest(failure=type(failure).__name__):
                store = Mock()
                with (patch.object(maintenance.os, 'umask'),
                      patch.object(maintenance.Settings, 'from_environment', return_value=self.settings),
                      patch.object(maintenance, 'Store', side_effect=[failure, store]) as create,
                      patch.object(maintenance.time, 'sleep', side_effect=[None, KeyboardInterrupt]) as sleep,
                      patch('sys.stdout', new_callable=io.StringIO) as out,
                      patch('sys.stderr', new_callable=io.StringIO) as err):
                    with self.assertRaises(KeyboardInterrupt):
                        maintenance.main()
                self.assertEqual(create.call_count, 2)
                store.prune.assert_called_once_with()
                self.assertEqual(sleep.call_args_list, [call(60), call(60)])
                self.assertEqual(out.getvalue(), 'retention_unavailable\n')
                self.assertEqual(err.getvalue(), '')

    def test_retention_retries_prune_failure_without_logging_exception(self):
        store = Mock()
        store.prune.side_effect = [sqlite3.OperationalError('PRIVATE_SQL'), 0]
        with (patch.object(maintenance.os, 'umask'),
              patch.object(maintenance.Settings, 'from_environment', return_value=self.settings),
              patch.object(maintenance, 'Store', return_value=store) as create,
              patch.object(maintenance.time, 'sleep', side_effect=[None, KeyboardInterrupt]),
              patch('sys.stdout', new_callable=io.StringIO) as out,
              patch('sys.stderr', new_callable=io.StringIO) as err):
            with self.assertRaises(KeyboardInterrupt):
                maintenance.main()
        create.assert_called_once_with(self.settings)
        self.assertEqual(store.prune.call_count, 2)
        self.assertEqual(out.getvalue(), 'retention_unavailable\n')
        self.assertEqual(err.getvalue(), '')

    def test_real_http_boundary(self):
        class QuietHandler(WSGIRequestHandler):
            def log_message(self, *_args):
                pass
        server = make_server('127.0.0.1', 0, self.app, handler_class=QuietHandler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            url = f'http://127.0.0.1:{server.server_port}/v1/reports'
            req = urllib.request.Request(url, data=PAYLOAD, headers={'Content-Type': 'application/json'})
            with urllib.request.urlopen(req, timeout=5) as response:
                self.assertEqual(response.status, 201)
                self.assertTrue(json.load(response)['accepted'])
            with self.assertRaises(urllib.error.HTTPError) as error:
                urllib.request.urlopen(urllib.request.Request(url, data=b'{', headers={'Content-Type': 'application/json'}), timeout=5)
            self.assertEqual(error.exception.code, 400)
            error.exception.close()
        finally:
            server.shutdown()
            thread.join(5)
            server.server_close()


if __name__ == '__main__':
    unittest.main()
