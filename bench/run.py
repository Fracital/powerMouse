#!/usr/bin/env python3
"""
bench/run.py - run the proxy benchmark.

    python3 -I bench/run.py [--repeats 5] [--only stomp-js,scramjet] [--out bench/results/<name>]
                            [--scenarios size,fidelity,...] [--sites wikipedia,mdn] [--headless]

Sets up every contender at its pinned version (bench/lib/setup.mjs, idempotent; --no-setup skips
it), then runs the Node driver (bench/lib/driver.mjs), which starts holyWisp, the fixture servers
and Chrome and writes results.json, runs.jsonl, results.csv and results.md to --out. Draw the
charts with `python3 -I bench/charts.py <out> --png`. bench/README.md has the method.
No dependencies beyond the standard library; the driver needs Node 22 or newer and the
repository's node_modules (npm ci) and dist/ (npm run build).
"""
import argparse
import datetime
import os
import pathlib
import shutil
import subprocess
import sys

BENCH = pathlib.Path(__file__).resolve().parent
REPO = BENCH.parent
SCENARIOS = "size,fidelity,fixtures,first-visit,spa,memory,real,rewrite-offline,sites"


def find_node(explicit):
    node = explicit or os.environ.get("BENCH_NODE") or shutil.which("node")
    if not node:
        sys.exit("run.py: no Node found (set BENCH_NODE or --node)")
    version = subprocess.run([node, "--version"], capture_output=True, text=True).stdout.strip()
    if int(version.lstrip("v").split(".")[0]) < 22:
        sys.exit(f"run.py: {node} is {version}; the driver needs Node 22 or newer")
    return node


def main():
    p = argparse.ArgumentParser(description="Run the proxy benchmark (see bench/README.md).")
    p.add_argument("--out", help="results directory (default bench/results/<date>)")
    p.add_argument("--repeats", type=int, default=5, help="repeats of every timing (default 5)")
    p.add_argument("--only", help="rows to run besides native, e.g. stomp-js,scramjet (default all)")
    p.add_argument("--scenarios", default=SCENARIOS, help=f"default {SCENARIOS}")
    p.add_argument("--sites", help="corpus site ids for the site-support scenario (default all)")
    p.add_argument("--parallel", type=int, default=8, help="corpus sites loading at once (default 8)")
    p.add_argument("--spacing", type=int, default=15000, help="ms between two loads of one site (default 15000)")
    p.add_argument("--headless", action="store_true",
                   help="site support in headless Chrome (default headful, under Xvfb when DISPLAY is unset)")
    p.add_argument("--merge", action="store_true", help="keep the other scenarios already in --out")
    p.add_argument("--chrome", help="Chrome binary (default $CHROME or ~/.cache/stomp-chrome/156/...)")
    p.add_argument("--holywisp", help="holyWisp binary (default $HOLYWISP or ~/src/holyWisp/build/release/holywisp)")
    p.add_argument("--contenders", help="where the contenders are set up (default $BENCH_CONTENDERS or bench/.contenders)")
    p.add_argument("--node", help="Node binary (default $BENCH_NODE or node on PATH)")
    p.add_argument("--no-setup", action="store_true", help="do not run bench/lib/setup.mjs first")
    args = p.parse_args()

    node = find_node(args.node)
    if not (REPO / "dist" / "serviceWorker.js").exists():
        sys.exit("run.py: no dist/ in the repository; run `npm ci && npm run build` first")
    out = args.out or str(BENCH / "results" / datetime.date.today().isoformat())
    common = []
    if args.contenders:
        common += ["--contenders", args.contenders]
    if args.node:
        common += ["--node", args.node]
    if not args.no_setup:
        rc = subprocess.run([node, str(BENCH / "lib" / "setup.mjs"), *common], cwd=REPO).returncode
        if rc:
            sys.exit(f"run.py: contender setup failed ({rc})")
    cmd = [node, str(BENCH / "lib" / "driver.mjs"), "--out", out, "--repeats", str(args.repeats),
           "--scenarios", args.scenarios, "--parallel", str(args.parallel), "--spacing", str(args.spacing),
           *common]
    for flag in ("only", "sites", "chrome", "holywisp"):
        value = getattr(args, flag)
        if value:
            cmd += [f"--{flag}", value]
    if not args.headless:
        cmd.append("--headful")
    if args.merge:
        cmd.append("--merge")
    sys.exit(subprocess.run(cmd, cwd=REPO).returncode)


if __name__ == "__main__":
    main()
