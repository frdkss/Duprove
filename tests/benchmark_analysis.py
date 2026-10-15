"""Synthetic stage-5 benchmark. Does not enumerate or scan user drives."""
import ctypes
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]
BINARY = Path(os.environ.get('DUPROVE_ANALYZER', str(ROOT / 'build/native/bin' / ('duprove-analyzer.exe' if os.name == 'nt' else 'duprove-analyzer'))))

def sample(process):
    if os.name == 'nt':
        from ctypes import wintypes
        class Memory(ctypes.Structure):
            _fields_ = [('cb', wintypes.DWORD), ('faults', wintypes.DWORD)] + [(name, ctypes.c_size_t) for name in
                ('peak_rss', 'rss', 'peak_paged', 'paged', 'peak_nonpaged', 'nonpaged', 'private', 'peak_private')]
        memory = Memory(); memory.cb = ctypes.sizeof(memory)
        handle = wintypes.HANDLE(int(process._handle))
        if not ctypes.windll.psapi.GetProcessMemoryInfo(handle, ctypes.byref(memory), memory.cb):
            raise ctypes.WinError()
        created, exited, kernel, user = [wintypes.FILETIME() for _ in range(4)]
        if not ctypes.windll.kernel32.GetProcessTimes(handle, ctypes.byref(created), ctypes.byref(exited), ctypes.byref(kernel), ctypes.byref(user)):
            raise ctypes.WinError()
        seconds = lambda value: ((value.dwHighDateTime << 32) | value.dwLowDateTime) / 1e7
        return seconds(kernel) + seconds(user), memory.peak_rss, memory.peak_private
    if Path(f'/proc/{process.pid}/stat').exists():
        fields = Path(f'/proc/{process.pid}/stat').read_text().rsplit(')', 1)[1].split()
        cpu = (int(fields[11]) + int(fields[12])) / os.sysconf('SC_CLK_TCK')
        rss = int(fields[21]) * os.sysconf('SC_PAGE_SIZE')
        return cpu, rss, 0
    raise RuntimeError('This benchmark sampler supports Windows and Linux; macOS needs native measurement.')

fixtures = Path(os.environ.get('DUPROVE_BENCHMARK_ROOT', str(ROOT / '.verification/native-fixtures')))
fixtures.mkdir(parents=True, exist_ok=True)
results = []
with tempfile.TemporaryDirectory(prefix='runtime-', dir=fixtures) as temporary:
    base = Path(temporary)
    data = base / 'data'; data.mkdir()
    payload_mib = int(os.environ.get('DUPROVE_BENCHMARK_MIB', '16'))
    payload = bytes(range(256)) * (payload_mib * 1024 * 1024 // 256)
    file_count = int(os.environ.get('DUPROVE_BENCHMARK_FILES', '3'))
    unique = os.environ.get('DUPROVE_BENCHMARK_UNIQUE') == '1'
    for index in range(file_count):
        (data / f'{index}.bin').write_bytes(index.to_bytes(8, 'little') + payload[8:] if unique else payload)
    for mode in map(int, os.environ.get('DUPROVE_BENCHMARK_MODES', '0,1,2').split(',')):
        job = base / 'job.json'
        job.write_text(json.dumps({'roots': [str(data)], 'database': str(base / f'work-{mode}/index.sqlite'), 'load': mode}), encoding='utf-8')
        output = base / 'events.ndjson'
        with output.open('w', encoding='utf-8') as stream:
            started = time.perf_counter()
            process = subprocess.Popen([str(BINARY), '--job', str(job)], stdin=subprocess.DEVNULL, stdout=stream, stderr=subprocess.DEVNULL)
            cpu = peak_rss = peak_private = 0
            while process.poll() is None:
                try:
                    c, rss, private = sample(process)
                    cpu = max(cpu, c); peak_rss = max(peak_rss, rss); peak_private = max(peak_private, private)
                except (FileNotFoundError, ProcessLookupError):
                    pass
                time.sleep(.02)
            elapsed = time.perf_counter() - started
        assert process.returncode == 0, process.returncode
        result = json.loads(output.read_text(encoding='utf-8').splitlines()[-1])
        assert result['report']['complete'] and result['report']['statistics']['total']['duplicates'] == (0 if unique else file_count - 1)
        read_mib = result['resources']['read_bytes'] / 1024 ** 2
        row = {'mode': ['low', 'medium', 'high'][mode], 'seconds': round(elapsed, 3),
               'cpu_percent_one_core': round(cpu / elapsed * 100, 2), 'read_mib': read_mib,
               'read_mib_s': round(read_mib / elapsed, 2), 'peak_rss_mib': round(peak_rss / 1024 ** 2, 2),
               'peak_commit_mib': round(peak_private / 1024 ** 2, 2)}
        row['hash_workers'] = result['resources'].get('hash_workers', 1)
        row['cpu_percent_machine'] = round(row['cpu_percent_one_core'] / (os.cpu_count() or 1), 2)
        if mode < 2:
            assert row['cpu_percent_one_core'] <= [65, 90][mode], row
        # The limiter permits a bounded 20 ms burst; the average includes startup.
        if mode < 2:
            assert row['read_mib_s'] <= [64, 256][mode] * 1.05, row
        assert row['peak_rss_mib'] <= [512, 1024, 2048][mode], row
        assert row['peak_commit_mib'] <= [512, 1024, 2048][mode], row
        results.append(row)
summary = {'platform': os.name, 'fixture': f'{file_count} {"unique same-size" if unique else "identical"} {payload_mib} MiB binary files; fresh DB per mode; warm filesystem cache; no content decoding', 'results': results}
(ROOT / '.verification' / os.environ.get('DUPROVE_BENCHMARK_RESULT', f'analysis-benchmark-{os.name}.json')).write_text(json.dumps(summary, indent=2) + '\n', encoding='utf-8')
print(json.dumps(summary, indent=2))
