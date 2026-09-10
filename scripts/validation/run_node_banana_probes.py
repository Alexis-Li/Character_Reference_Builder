"""Run offline requirement probes in an installed Node Banana snapshot.

Exit 0: all requirements passed; 1: upstream requirement failures; 2: setup error.
The temporary probe file is removed after running. Upstream production code is untouched.
"""
import argparse
import json
from pathlib import Path
import shutil
import subprocess
import sys


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("candidate", type=Path, help="Extracted Node Banana directory with npm ci completed")
    parser.add_argument("--report", type=Path, required=True, help="Vitest JSON report output path")
    args = parser.parse_args()
    candidate = args.candidate.resolve()
    report = args.report.resolve()
    source = Path(__file__).with_name("node-banana.probe.test.ts")
    destination = candidate / "src" / "__tests__" / "crb-validation.probe.test.ts"
    vitest = candidate / "node_modules" / "vitest" / "vitest.mjs"
    node = shutil.which("node")
    if not node or not vitest.is_file() or not (candidate / "vitest.config.ts").is_file():
        parser.error("Node.js or installed candidate missing. Extract the documented snapshot and run npm ci first.")
    if destination.exists():
        parser.error(f"Refusing to overwrite an existing file: {destination}")
    report.parent.mkdir(parents=True, exist_ok=True)
    destination.parent.mkdir(parents=True, exist_ok=True)
    try:
        shutil.copyfile(source, destination)
        result = subprocess.run([node, str(vitest), "run", str(destination),
                                 "--reporter=json", f"--outputFile={report}"], cwd=candidate)
        if report.is_file():
            data = json.loads(report.read_text(encoding="utf-8"))
            print(json.dumps({k: data.get(k) for k in
                              ("numTotalTests", "numPassedTests", "numFailedTests")}, ensure_ascii=False))
        return 0 if result.returncode == 0 else 1
    finally:
        destination.unlink(missing_ok=True)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError) as error:
        print(f"Validation setup failed: {error}", file=sys.stderr)
        sys.exit(2)
