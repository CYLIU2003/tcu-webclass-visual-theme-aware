"""Download the reviewed official source manifest; does not change extension data."""
import concurrent.futures
import hashlib
import json
from pathlib import Path
import requests
import argparse

ROOT = Path(__file__).resolve().parents[1]
DEST = ROOT / 'tmp/timetable-sources'
DEST.mkdir(parents=True, exist_ok=True)
manifest = json.loads((ROOT / 'scripts/timetable-sources-2026.json').read_text(encoding='utf-8'))
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--refresh',action='store_true',help='Re-download existing PDFs and update their hashes')
args=parser.parse_args()

def fetch(source):
    path = DEST / (source['id'] + '.pdf')
    if args.refresh or not path.exists():
        response = requests.get(source['url'], timeout=90)
        response.raise_for_status()
        if not response.content.startswith(b'%PDF'):
            raise ValueError('Not a PDF: ' + source['url'])
        path.write_bytes(response.content)
    return {**source, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest(), 'bytes': path.stat().st_size}

with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
    sources = list(pool.map(fetch, manifest['sources']))
manifest['sources'] = sources
(DEST / 'download-manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
for source in sources:
    print(source['id'], source['bytes'], source['sha256'][:12], flush=True)
