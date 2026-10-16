"""Periodic expiry also runs when the receiver has no traffic."""
import os
import sqlite3
import time

from .settings import Settings
from .storage import StorageFull, Store


def main():
    os.umask(0o077)
    settings = Settings.from_environment()
    store = None
    while True:
        try:
            if store is None:
                store = Store(settings)
            store.prune()
        except (sqlite3.Error, OSError, StorageFull):
            # Fixed diagnostic only; never exception text, payloads or IPs.
            print('retention_unavailable', flush=True)
        time.sleep(60)


if __name__ == '__main__':
    main()
