import json
from pathlib import Path
from jsonschema import Draft7Validator

SCHEMA = json.loads((Path(__file__).resolve().parents[2] / 'contracts' / 'report.schema.json').read_text(encoding='utf-8'))
Draft7Validator.check_schema(SCHEMA)
VALIDATOR = Draft7Validator(SCHEMA)


def is_report(value):
    if not VALIDATOR.is_valid(value):
        return False
    s, groups = value['statistics'], value['duplicates']
    standard = s['locations']['standard']
    summaries = [s['total'], *s['disks'], standard['total'], *standard['categories'].values(), s['locations']['custom']]
    byte_report = (any('file_bytes' in x or 'duplicate_bytes' in x for x in summaries)
                   or any('size_bytes' in g for g in groups) or 'reclaimable_bytes' in s['total'])
    if byte_report:
        if (any('file_bytes' not in x or 'duplicate_bytes' not in x or x['duplicate_bytes'] > x['file_bytes'] for x in summaries)
                or any('size_bytes' not in g for g in groups) or 'reclaimable_bytes' not in s['total']):
            return False
        def group_bytes(key, field):
            return sum(g[field].get(key, 0) * g['size_bytes'] for g in groups)
        if (s['total']['duplicate_bytes'] != sum(g['copies'] * g['size_bytes'] for g in groups)
                or s['total']['reclaimable_bytes'] != sum(g['duplicates'] * g['size_bytes'] for g in groups)
                or any(d['duplicate_bytes'] != group_bytes(str(d['id']), 'disks') for d in s['disks'])
                or any(x['duplicate_bytes'] != group_bytes(k, 'categories') for k, x in standard['categories'].items())
                or s['locations']['custom']['duplicate_bytes'] != group_bytes('custom', 'categories')):
            return False
        def byte_partition(total, parts):
            return all(total[k] == sum(p[k] for p in parts) for k in ('file_bytes', 'duplicate_bytes'))
        if (not byte_partition(s['total'], s['disks'])
                or not byte_partition(s['total'], [standard['total'], s['locations']['custom']])
                or not byte_partition(standard['total'], list(standard['categories'].values()))):
            return False
    volumes, volume_keys = [s['total'], *s['disks']], ('capacity_bytes', 'available_bytes', 'used_bytes')
    if any(any(k in x for k in volume_keys) for x in volumes):
        if (any(any(k not in x for k in volume_keys) or x['used_bytes'] + x['available_bytes'] != x['capacity_bytes'] for x in volumes)
                or any(s['total'][k] != sum(d[k] for d in s['disks']) for k in volume_keys)):
            return False
    if 'progress' in value:
        progress = value['progress']
        if (len(progress['disks']) != len(s['disks']) or value['complete'] and progress['status'] != 'completed'):
            return False
        for i, d in enumerate(progress['disks']):
            if d['id'] != i:
                return False
            w = d.get('work')
            if w and (w['total'] is not None and w['done'] > w['total']
                      or ('files_done' in w) != ('files_total' in w)
                      or 'files_done' in w and w['files_done'] > w['files_total']
                      or 'cached_files' in w and ('files_done' not in w or w['cached_files'] > w['files_done'])):
                return False
    if any(x['files'] != sum(x['types'].values()) or x['empty'] != x['types'].get('empty', 0)
           or x['duplicate_members'] > x['files'] - x['empty'] or x['duplicate_groups'] > x['duplicate_members']
           for x in summaries):
        return False
    if any(disk['id'] != i for i, disk in enumerate(s['disks'])):
        return False
    if (s['total']['duplicates'] != sum(g['duplicates'] for g in groups)
            or s['total']['duplicate_groups'] != len(groups)
            or s['total']['duplicate_members'] != sum(g['copies'] for g in groups)):
        return False
    types = {}
    for g in groups:
        if (g['duplicates'] != g['copies'] - 1
                or any(g['copies'] != sum(g[field].values()) for field in ('extensions', 'disks', 'categories'))
                or any(int(i) >= len(s['disks']) for i in g['disks'])):
            return False
        for ext, n in g['extensions'].items():
            types[ext] = types.get(ext, 0) + n
    if any(n > s['total']['types'].get(ext, 0) for ext, n in types.items()):
        return False

    def members(x, key, field):
        return (x['duplicate_members'] == sum(g[field].get(key, 0) for g in groups)
                and x['duplicate_groups'] == sum(key in g[field] for g in groups))

    if any(not members(d, str(d['id']), 'disks') for d in s['disks']):
        return False
    if (any(not members(x, key, 'categories') for key, x in standard['categories'].items())
            or not members(s['locations']['custom'], 'custom', 'categories')
            or standard['total']['duplicate_groups'] != sum(any(k != 'custom' for k in g['categories']) for g in groups)):
        return False

    def partition(total, parts):
        if any(total[k] != sum(p[k] for p in parts) for k in ('files', 'empty', 'duplicate_members')):
            return False
        keys = set(total['types']).union(*(p['types'] for p in parts))
        return all(total['types'].get(k, 0) == sum(p['types'].get(k, 0) for p in parts) for k in keys)

    return (partition(s['total'], s['disks'])
            and partition(s['total'], [standard['total'], s['locations']['custom']])
            and partition(standard['total'], list(standard['categories'].values())))
