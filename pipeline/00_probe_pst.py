#!/usr/bin/env python3
"""Diagnostic probe: open a (possibly corrupt) PST with pypff and report what is reachable.

Usage: python3 00_probe_pst.py /path/to/file.pst

Exit codes:
  0  pypff opened the file successfully (folder walk possible -> Tier 1+2)
  1  pypff opened the file but root folder is unreadable (orphan-only -> Tier 2)
  2  pypff cannot open the file at all (need pffexport CLI -> Tier 3)
"""
from __future__ import annotations

import sys
import time
import traceback

try:
    import pypff
except ImportError:
    print("ERROR: pypff not installed. Run: pip3 install libpff-python", file=sys.stderr)
    sys.exit(3)


def walk_count(folder, depth=0, max_depth=20, counts=None):
    if counts is None:
        counts = {"folders": 0, "messages": 0, "max_depth": 0, "errors": 0}
    counts["folders"] += 1
    counts["max_depth"] = max(counts["max_depth"], depth)
    if depth >= max_depth:
        return counts
    try:
        n_msgs = folder.get_number_of_sub_messages()
        counts["messages"] += n_msgs
    except Exception:
        counts["errors"] += 1
    try:
        n_sub = folder.get_number_of_sub_folders()
    except Exception:
        counts["errors"] += 1
        return counts
    for i in range(n_sub):
        try:
            sub = folder.get_sub_folder(i)
            walk_count(sub, depth + 1, max_depth, counts)
        except Exception:
            counts["errors"] += 1
    return counts


def main():
    if len(sys.argv) != 2:
        print(__doc__, file=sys.stderr)
        sys.exit(99)
    path = sys.argv[1]

    print(f"probe: pypff version = {pypff.get_version()}")
    print(f"probe: target = {path}")

    pff = pypff.file()
    t0 = time.time()
    try:
        pff.open(path)
    except Exception as e:
        print(f"FAIL: pypff.open() raised: {type(e).__name__}: {e}")
        traceback.print_exc()
        sys.exit(2)
    print(f"OK: opened in {time.time() - t0:.1f}s")

    try:
        n_orphans = pff.get_number_of_orphan_items()
    except Exception as e:
        n_orphans = -1
        print(f"WARN: orphan count failed: {e}")
    print(f"orphans: {n_orphans}")

    try:
        root = pff.get_root_folder()
    except Exception as e:
        print(f"FAIL: cannot get root folder: {e}")
        sys.exit(1)

    t1 = time.time()
    try:
        counts = walk_count(root)
    except Exception as e:
        print(f"FAIL: walk crashed: {e}")
        traceback.print_exc()
        sys.exit(1)
    elapsed = time.time() - t1

    print(
        f"walk: folders={counts['folders']} messages={counts['messages']} "
        f"max_depth={counts['max_depth']} walk_errors={counts['errors']} "
        f"elapsed={elapsed:.1f}s"
    )

    if counts["folders"] >= 5 or counts["messages"] >= 100:
        print("RECOMMEND: start at Tier 1 (folder walk)")
        sys.exit(0)
    if n_orphans > 0:
        print("RECOMMEND: skip to Tier 2 (orphan-only)")
        sys.exit(1)
    print("RECOMMEND: skip to Tier 3 (pffexport CLI)")
    sys.exit(1)


if __name__ == "__main__":
    main()
