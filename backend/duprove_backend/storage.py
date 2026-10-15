"""Bounded transactional storage. No addresses, headers or client identifiers."""
from contextlib import closing, contextmanager
import sqlite3
import time
from uuid import uuid4

from .settings import Settings


class StorageFull(Exception):
    pass


class Store:
    def __init__(self, settings: Settings):
        self.settings = settings
        settings.database.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        with self.connection() as db, db:
            db.execute('PRAGMA journal_mode=DELETE')
            db.execute('CREATE TABLE IF NOT EXISTS reports ('
                       'id TEXT PRIMARY KEY, received_at INTEGER NOT NULL, payload BLOB NOT NULL)')
            db.execute('CREATE INDEX IF NOT EXISTS reports_received ON reports(received_at)')
            db.execute('CREATE TABLE IF NOT EXISTS usage ('
                       'id INTEGER PRIMARY KEY CHECK(id=1), reports INTEGER NOT NULL, bytes INTEGER NOT NULL)')
            db.execute('INSERT OR IGNORE INTO usage VALUES (1, 0, 0)')
            db.execute('CREATE TRIGGER IF NOT EXISTS reports_added AFTER INSERT ON reports BEGIN '
                       'UPDATE usage SET reports=reports+1, bytes=bytes+length(NEW.payload) WHERE id=1; END')
            db.execute('CREATE TRIGGER IF NOT EXISTS reports_removed AFTER DELETE ON reports BEGIN '
                       'UPDATE usage SET reports=reports-1, bytes=bytes-length(OLD.payload) WHERE id=1; END')
        settings.database.chmod(0o600)

    @contextmanager
    def connection(self, deadline=None):
        with closing(sqlite3.connect(self.settings.database, timeout=0.25)) as db:
            db.execute('PRAGMA secure_delete=ON')
            db.execute('PRAGMA synchronous=FULL')
            db.execute('PRAGMA temp_store=MEMORY')
            db.execute('PRAGMA cache_size=-2048')
            page_size = db.execute('PRAGMA page_size').fetchone()[0]
            maximum = self.settings.max_database_bytes // page_size
            actual = db.execute(f'PRAGMA max_page_count={maximum}').fetchone()[0]
            if actual > maximum:
                raise StorageFull()
            if deadline is not None:
                db.set_progress_handler(lambda: int(time.monotonic() >= deadline), 1000)
            yield db

    def save(self, payload: bytes, deadline: float, now=None):
        received_at = int(time.time() if now is None else now)
        with self.connection(deadline) as db, db:
            db.execute('BEGIN IMMEDIATE')
            count, size = db.execute('SELECT reports, bytes FROM usage WHERE id=1').fetchone()
            if count >= self.settings.max_reports or size + len(payload) > self.settings.max_payload_bytes:
                raise StorageFull()
            if time.monotonic() >= deadline:
                raise TimeoutError()
            # A fresh server receipt is not a persistent user/device identifier.
            receipt = str(uuid4())
            db.execute('INSERT INTO reports VALUES (?, ?, ?)', (receipt, received_at, payload))
        return receipt

    def prune(self, now=None, seconds=10):
        cutoff = int(time.time() if now is None else now) - self.settings.retention_seconds
        deadline = time.monotonic() + seconds
        deleted = 0
        # Small commits keep rollback journal and writer lock duration bounded.
        while time.monotonic() < deadline:
            with self.connection(deadline) as db, db:
                changed = db.execute('DELETE FROM reports WHERE id IN '
                                     '(SELECT id FROM reports WHERE received_at <= ? LIMIT 100)',
                                     (cutoff,)).rowcount
            deleted += changed
            if changed < 100:
                break
        return deleted

    def healthy(self):
        with self.connection() as db:
            return db.execute('SELECT 1 FROM usage WHERE id=1').fetchone() == (1,)
