"""Verify captured official source files, optionally retrieving missing snapshots."""
import argparse
import hashlib
import json
from pathlib import Path
from urllib.parse import urlparse
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
manifest = json.loads((ROOT / "data/curriculum-source-snapshots.json").read_text(encoding="utf-8"))
parser = argparse.ArgumentParser()
parser.add_argument("--fetch-missing", action="store_true")
args = parser.parse_args()
for source in manifest["records"]:
    target = (ROOT / source["file"]).resolve()
    assert target.is_relative_to((ROOT / "data/source-cache/curriculum").resolve())
    url = urlparse(source["url"])
    assert url.scheme == "https" and url.hostname in {"www.asc.tcu.ac.jp", "hirameki.tcu.ac.jp"}
    if not target.exists() and args.fetch_missing:
        data = urlopen(Request(source["url"], headers={"User-Agent": "Mozilla/5.0"}), timeout=60).read()
        if len(data) != source["size"] or hashlib.sha256(data).hexdigest() != source["sha256"]:
            raise ValueError(f"Remote source changed: {source['id']}; do not replace the snapshot")
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open("xb") as stream:
            stream.write(data)
    data = target.read_bytes()
    if len(data) != source["size"] or hashlib.sha256(data).hexdigest() != source["sha256"]:
        raise ValueError(f"Source mismatch: {source['id']}")
print(f"PASS: {len(manifest['records'])} curriculum source snapshots match")
