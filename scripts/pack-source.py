"""Archive the desktop application's sources using only the Python standard library."""

import argparse
from datetime import datetime
import os
from pathlib import Path
import sys
from time import perf_counter
from zipfile import ZIP_DEFLATED, ZipFile


ROOT = Path(__file__).resolve().parents[1]
CODE = {".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".css", ".html", ".json"}
ASSETS = {".svg", ".png", ".ico", ".jpg", ".jpeg", ".webp", ".gif", ".avif",
          ".woff", ".woff2", ".ttf", ".otf"}
SOURCE_TREES = {
    "src": CODE | ASSETS,
    "electron": CODE,
    "native/src": {".c", ".cc", ".cpp", ".cxx", ".h", ".hh", ".hpp", ".hxx", ".mm", ".inc"},
    "native/cmake": {".cmake"},
    "contracts": CODE,
    "public": ASSETS,
}
SOURCE_FILES = (
    "index.html",
    "package.json",
    "package-lock.json",
    "tsconfig.json",
    "vite.config.ts",
    "native/CMakeLists.txt",
    "config/update-public-key.pem",
    "scripts/build-electron.mjs",
    "scripts/build-icons.mjs",
    "installer/update-linux.sh",
    "installer/update-windows.ps1",
    "LICENSE",
)
SKIP_DIRS = {
    "node_modules", "__pycache__", "build", "dist", "dist-electron", "release",
    "coverage", "logs", "tests", "__tests__", "fixtures", "docs", "venv", "env",
}
SKIP_ENDINGS = (".test.ts", ".test.tsx", ".test.js", ".test.jsx", ".test.mjs",
                ".test.cjs", ".spec.ts", ".spec.tsx", ".spec.js", ".spec.jsx",
                ".spec.mjs", ".spec.cjs")


def is_link(path):
    return path.is_symlink() or path.is_junction()


def walk_error(error):
    raise error


def collect_sources(root):
    files = []
    for relative, extensions in SOURCE_TREES.items():
        directory = root / relative
        if not directory.is_dir() or is_link(directory):
            raise OSError(f"Missing source directory or linked directory: {directory}")
        for current, directories, names in os.walk(directory, onerror=walk_error, followlinks=False):
            directories[:] = sorted(name for name in directories
                                    if not name.startswith(".") and name.lower() not in SKIP_DIRS
                                    and not is_link(Path(current) / name))
            for name in sorted(names):
                path = Path(current) / name
                if (not name.startswith(".") and path.suffix.lower() in extensions
                        and not name.lower().endswith(SKIP_ENDINGS) and not is_link(path)):
                    files.append(path)
    for relative in SOURCE_FILES:
        path = root / relative
        if not path.is_file() or is_link(path) or any(is_link(parent) for parent in path.parents if parent != root):
            raise OSError(f"Missing source file or linked path: {path}")
        files.append(path)
    return sorted(files, key=lambda path: path.relative_to(root).as_posix())


def pack_sources(root, output):
    files = collect_sources(root)
    output.parent.mkdir(parents=True, exist_ok=True)
    # Exclusive creation protects existing archives and source files from overwriting.
    with output.open("xb") as stream:
        try:
            with ZipFile(stream, "w", compression=ZIP_DEFLATED, compresslevel=1) as archive:
                for path in files:
                    archive.write(path, path.relative_to(root).as_posix())
        except BaseException:
            stream.close()
            output.unlink()
            raise
    return len(files)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("-o", "--output", type=Path,
                        help="ZIP path (default: source-archives/Duprove-source-<timestamp>.zip)")
    args = parser.parse_args()
    output = args.output or ROOT / "source-archives" / f"Duprove-source-{datetime.now():%Y%m%d-%H%M%S-%f}.zip"
    if output.suffix.lower() != ".zip":
        parser.error("Output must have a .zip extension")
    output = output.absolute()
    started = perf_counter()
    try:
        count = pack_sources(ROOT, output)
    except FileExistsError:
        print(f"Archive already exists: {output}", file=sys.stderr)
        return 1
    except (OSError, ValueError) as error:
        print(f"Source archive failed: {error}", file=sys.stderr)
        return 1
    print(f"Archive: {output}")
    print(f"Files: {count} | Size: {output.stat().st_size / 1024:.1f} KiB | Time: {perf_counter() - started:.2f} s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
