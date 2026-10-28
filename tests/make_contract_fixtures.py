import copy
import json
from pathlib import Path

CATEGORIES = ('downloads', 'documents', 'videos', 'pictures', 'music', 'desktop')


def summary(types=None, members=0, groups=0):
    types = types or {}
    return dict(files=sum(types.values()), empty=types.get('empty', 0), types=types,
                duplicate_members=members, duplicate_groups=groups)


def fixtures():
    cats = {c: summary() for c in CATEGORIES}
    cats['documents'] = summary({'.txt': 2}, 2, 1)
    cats['downloads'] = summary({'.jpg': 1})
    report = dict(schema_version=1, complete=True, statistics={
        'total': dict(summary({'.txt': 2, '.bin': 1, '.jpg': 1, 'empty': 1}, 3, 1), duplicates=2),
        'disks': [dict(summary({'.txt': 2}, 2, 1), id=0), dict(summary({'.bin': 1, '.jpg': 1, 'empty': 1}, 1, 1), id=1)],
        'locations': {'standard': {'total': summary({'.txt': 2, '.jpg': 1}, 2, 1), 'categories': cats},
                      'custom': summary({'.bin': 1, 'empty': 1}, 1, 1)}},
        duplicates=[dict(copies=3, duplicates=2, extensions={'.txt': 2, '.bin': 1}, disks={'0': 2, '1': 1}, categories={'documents': 2, 'custom': 1})])
    cases = [dict(name='mixed extensions and cross-disk/category group', valid=True, report=report)]
    partial = copy.deepcopy(report)
    partial['complete'] = False
    cases.append(dict(name='partial result', valid=True, report=partial))
    empty = dict(schema_version=1, complete=True, statistics={
        'total': dict(summary(), duplicates=0), 'disks': [dict(summary(), id=0)],
        'locations': {'standard': {'total': summary(), 'categories': {c: summary() for c in CATEGORIES}}, 'custom': summary()}}, duplicates=[])
    cases.append(dict(name='empty scan', valid=True, report=empty))
    for ext in ('.my_format', '.long-' + 'x' * 30, '.данные', '.c++', '.tar.gz', '.' + 'x' * 254):
        extended = copy.deepcopy(empty)
        extended['statistics']['total'] = dict(summary({ext: 1}), duplicates=0)
        extended['statistics']['disks'] = [dict(summary({ext: 1}), id=0)]
        extended['statistics']['locations']['custom'] = summary({ext: 1})
        cases.append(dict(name='literal extension ' + ext, valid=True, report=extended))
    split = copy.deepcopy(report)
    split['statistics']['locations']['standard']['categories']['documents'] = summary({'.txt': 1}, 1, 1)
    split['statistics']['locations']['standard']['categories']['downloads'] = summary({'.txt': 1, '.jpg': 1}, 1, 1)
    split['duplicates'][0]['categories'] = {'documents': 1, 'downloads': 1, 'custom': 1}
    cases.append(dict(name='standard total counts shared group once', valid=True, report=split))

    def changed(name, path, value, remove=False):
        data = copy.deepcopy(report)
        target = data
        for key in path[:-1]:
            target = target[key]
        if remove:
            del target[path[-1]]
        else:
            target[path[-1]] = value
        cases.append(dict(name=name, valid=False, report=data))

    for path in [[], ['statistics'], ['statistics', 'total'], ['statistics', 'disks', 0],
                 ['statistics', 'locations'], ['statistics', 'locations', 'standard'],
                 ['statistics', 'locations', 'standard', 'categories', 'documents'],
                 ['statistics', 'locations', 'custom'], ['duplicates', 0]]:
        changed('forbidden field at ' + str(path), path + ['path'], 'PRIVATE_FILENAME')
    for value in [-1, 1.5, True, '5', None, 9007199254740992]:
        changed('invalid counter ' + repr(value), ['statistics', 'total', 'files'], value)
    mutations = [
        ('version', ['schema_version'], 2), ('missing complete', ['complete'], None, True),
        ('empty disks', ['statistics', 'disks'], []),
        ('noncontiguous disk ids', ['statistics', 'disks', 1, 'id'], 0),
        ('missing category', ['statistics', 'locations', 'standard', 'categories', 'music'], None, True),
        ('custom folder name', ['statistics', 'locations', 'standard', 'categories', 'private'], summary()),
        ('filename in type', ['statistics', 'total', 'types', 'private.txt'], 1),
        ('uppercase extension', ['duplicates', 0, 'extensions'], {'.TXT': 3}),
        ('oversized extension', ['duplicates', 0, 'extensions'], {'.' + 'x' * 255: 3}),
        ('path separator in extension', ['statistics', 'total', 'types', '.txt/private'], 1),
        ('windows separator in extension', ['statistics', 'total', 'types', '.txt\\private'], 1),
        ('empty file in group', ['duplicates', 0, 'extensions'], {'empty': 3}),
        ('zero type count', ['statistics', 'total', 'types', '.zero'], 0),
        ('copies mismatch', ['duplicates', 0, 'copies'], 4),
        ('extras mismatch', ['duplicates', 0, 'duplicates'], 3),
        ('extensions mismatch', ['duplicates', 0, 'extensions'], {'.txt': 2}),
        ('unknown group disk', ['duplicates', 0, 'disks'], {'3': 3}),
        ('wrong group category', ['duplicates', 0, 'categories'], {'music': 3}),
        ('wrong total files', ['statistics', 'total', 'files'], 6),
        ('wrong empty count', ['statistics', 'total', 'empty'], 0),
        ('wrong total groups', ['statistics', 'total', 'duplicate_groups'], 2),
        ('wrong total extras', ['statistics', 'total', 'duplicates'], 3),
        ('wrong disk members', ['statistics', 'disks', 1, 'duplicate_members'], 0),
        ('wrong standard total', ['statistics', 'locations', 'standard', 'total', 'files'], 4),
        ('wrong types despite same sum', ['statistics', 'disks', 0, 'types'], {'.csv': 2}),
        ('more duplicate type members than files', ['duplicates', 0, 'extensions'], {'.bin': 3}),
    ]
    for mutation in mutations:
        changed(*mutation)
    return cases


def byte_example():
    report = copy.deepcopy(fixtures()[0]['report'])
    s = report['statistics']
    standard = s['locations']['standard']
    for x in [s['total'], *s['disks'], standard['total'], *standard['categories'].values(), s['locations']['custom']]:
        x['duplicate_bytes'] = x['duplicate_members'] * 12
        x['file_bytes'] = x['duplicate_bytes'] + x['types'].get('.jpg', 0) * 7
    s['total']['reclaimable_bytes'] = 24
    for x in [s['total'], *s['disks']]:
        x.update(capacity_bytes=200 if 'id' not in x else 100,
                 available_bytes=80 if 'id' not in x else 40,
                 used_bytes=120 if 'id' not in x else 60)
    report['duplicates'][0]['size_bytes'] = 12
    report['progress'] = {'updated_at': 1000, 'status': 'completed', 'disks': [
        {'id': i, 'phase': 'completed', 'percent': 100,
         'work': {'operation': 'saving', 'done': 0, 'total': None, 'unit': 'files', 'read_bytes': 48}}
        for i in range(2)]}
    return report


if __name__ == '__main__':
    directory = Path(__file__).resolve().parents[1] / 'contracts' / 'fixtures'
    directory.mkdir(exist_ok=True)
    cases = fixtures()
    (directory / 'cases.json').write_text(json.dumps(cases, indent=2) + '\n', encoding='utf-8')
    (directory / 'example.json').write_text(json.dumps(cases[0]['report'], indent=2) + '\n', encoding='utf-8')
    (directory / 'byte-example.json').write_text(json.dumps(byte_example(), indent=2) + '\n', encoding='utf-8')
