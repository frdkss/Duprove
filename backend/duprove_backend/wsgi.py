import os

from .server import Application
from .settings import Settings

os.umask(0o077)
application = Application(Settings.from_environment())
