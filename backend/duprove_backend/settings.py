"""Server policy; independent of the desktop application."""
from dataclasses import dataclass
import os
from pathlib import Path


@dataclass(frozen=True)
class Settings:
    database: Path
    max_request_bytes: int = 32 * 1024 * 1024
    max_payload_bytes: int = 256 * 1024 * 1024
    max_database_bytes: int = 480 * 1024 * 1024
    max_reports: int = 100_000
    retention_seconds: int = 30 * 86400
    processing_seconds: float = 30.0
    requests_per_minute: int = 60
    burst: int = 10

    def __post_init__(self):
        if any(value <= 0 for key, value in vars(self).items() if key != 'database'):
            raise ValueError('invalid_server_limits')
        if self.max_database_bytes < 65536:
            raise ValueError('database_limit_too_small')

    @classmethod
    def from_environment(cls):
        # Quotas are reviewed policy, not arbitrary remotely supplied values.
        return cls(database=Path(os.environ.get('DUPROVE_DATABASE', '/data/reports.sqlite3')))
