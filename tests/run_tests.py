#!/usr/bin/env python3
"""Command-line runner:  python3 tests/run_tests.py [TC-01 TC-05 ...]"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "dashboard", "backend"))
import tests_runner  # noqa: E402

only = set(sys.argv[1:]) or None
results = tests_runner.run_all(on_result=lambda r: print(f"{r['id']}  {r['status']:7} {r.get('name','')}") if r["status"] != "RUNNING" else None, only=only)
print()
for r in results:
    print(f"[{r['status']}] {r['id']} {r['module']}: {r['name']} ({r['duration_ms']} ms)")
    print(f"       input   : {r['input']}\n       expected: {r['expected']}\n       actual  : {r['actual']}")
failed = [r for r in results if r["status"] != "PASS"]
print(f"\n{len(results) - len(failed)}/{len(results)} test cases passed")
sys.exit(1 if failed else 0)
