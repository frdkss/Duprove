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
