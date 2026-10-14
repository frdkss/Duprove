import json
import sys
from .contract import is_report


def main():
    try:
        valid = is_report(json.load(sys.stdin))
    except (ValueError, RecursionError):
        valid = False
    print(json.dumps({'accepted': valid}))
    return 0 if valid else 1


if __name__ == '__main__':
    raise SystemExit(main())
