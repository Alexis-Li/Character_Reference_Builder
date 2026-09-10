"""Exercise an already-running local Node Banana file API without any cloud call.

Creates a fresh diagnostic-only project under --output. Never deletes previous runs.
Exit 0 means native-path storage passed, 1 means a probe failed, 2 is a setup error.
"""
import argparse
import base64
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import struct
import sys
import urllib.error
import urllib.parse
import urllib.request
import uuid
import zlib


def png(rgb):
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 64, 64, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress((b"\0" + bytes(rgb) * 64) * 64)) + chunk(b"IEND", b""))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="http://127.0.0.1:3210")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    parsed = urllib.parse.urlparse(args.base_url)
    if parsed.scheme != "http" or parsed.hostname not in ("127.0.0.1", "localhost", "::1"):
        parser.error("Only a loopback HTTP server is allowed; this probe never calls a cloud provider.")
    if parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in ("", "/"):
        parser.error("Supply only the loopback origin, without credentials, path, query, or fragment.")
    root = args.output.resolve() / ("storage-" + uuid.uuid4().hex[:10])
    root.mkdir(parents=True, exist_ok=False)
    project = root / "project"
    checks = []

    def request(route, body=None):
        req = urllib.request.Request(args.base_url.rstrip("/") + route,
                                     data=None if body is None else json.dumps(body).encode(),
                                     headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=45) as response:
                return response.status, json.load(response)
        except urllib.error.HTTPError as error:
            return error.code, json.load(error)

    def check(name, condition, **details):
        checks.append({"name": name, "passed": bool(condition), **details})

    try:
        assets = {}
        for name, color in (("original", (30, 90, 180)), ("candidate", (60, 160, 100)), ("refined", (180, 90, 40))):
            raw = png(color)
            data = "data:image/png;base64," + base64.b64encode(raw).decode()
            assets[name] = {"data": data, "sha256": hashlib.sha256(raw).hexdigest()}
        status, saved = request("/api/workflow-images", {
            "workflowPath": str(project), "imageId": "original", "imageData": assets["original"]["data"],
        })
        check("S01 native Windows input image write", status == 200 and saved.get("success"), status=status)
        if not saved.get("success"):
            raise RuntimeError(f"Cannot write input fixture: {saved.get('error')}")
        ids = {}
        for name in ("candidate", "refined"):
            status, result = request("/api/save-generation", {
                "directoryPath": str(project / "generations"), "createDirectory": True,
                "image": assets[name]["data"], "imageId": name,
                "prompt": "Synthetic storage fixture. Not an AI generation or character-quality sample.",
            })
            check(f"S02 {name} image write", status == 200 and result.get("success"), status=status)
            if not result.get("success"):
                raise RuntimeError(f"Cannot save fixture: {result.get('error')}")
            ids[name] = result["imageId"]
            _, loaded = request("/api/load-generation", {"directoryPath": str(project / "generations"), "imageId": ids[name]})
            check(f"S03 {name} bytes survive reload", loaded.get("image") == assets[name]["data"])
        # This JSON demonstrates existing generic graph storage, not CRB review/provenance semantics.
        workflow = {"version": 1, "name": "CRB storage diagnostic", "nodes": [
            {"id": name, "type": "imageInput", "position": {"x": i * 350, "y": 100},
             "data": {"image": asset["data"], "label": name + " (synthetic fixture)"}}
            for i, (name, asset) in enumerate(assets.items())], "edges": []}
        status, saved = request("/api/workflow", {"directoryPath": str(project), "filename": "crb-probe", "workflow": workflow})
        check("S04 workflow JSON write", status == 200 and saved.get("success"), status=status)
        status, loaded = request("/api/workflow?" + urllib.parse.urlencode({"path": str(project), "load": "true"}))
        check("S05 workflow JSON round trip", status == 200 and loaded.get("workflow") == workflow, status=status)
        _, alternate_path = request("/api/workflow?" + urllib.parse.urlencode({"path": project.as_posix()}))
        # Characterization only: does not make the native-path checks pass or fail.
        path_observation = {"posix_form_accepted": bool(alternate_path.get("success")), "error": alternate_path.get("error")}
        (root / "ui-fixture.json").write_text(json.dumps(workflow, indent=2), encoding="utf-8")
    except (OSError, ValueError, RuntimeError) as error:
        check("probe execution", False, error=str(error))
        path_observation = None
    report = {"timestamp": datetime.now(timezone.utc).isoformat(), "scope": "local synthetic storage only",
              "cloud_calls": 0, "checks": checks, "path_observation": path_observation,
              "passed": all(item["passed"] for item in checks)}
    (root / "result.json").write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    print(json.dumps({"report": str(root / "result.json"), **report}, indent=2, ensure_ascii=False))
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except OSError as error:
        print(f"Storage probe setup failed: {error}", file=sys.stderr)
        sys.exit(2)
