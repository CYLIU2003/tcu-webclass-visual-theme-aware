"""An existing catalog must not be replaced by a rebuild."""
from pathlib import Path
import subprocess
import sys
import tempfile

root = Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory(prefix="catalog-output-guard-") as temp:
    output = Path(temp)
    (output / "data").mkdir()
    sentinel = output / "data/course-catalog-2026.sqlite"
    sentinel.write_bytes(b"existing catalog")
    result = subprocess.run([sys.executable, str(root / "data/build_course_catalog.py"), "--output-root", str(output)], capture_output=True)
    assert result.returncode != 0
    assert sentinel.read_bytes() == b"existing catalog"
    assert not (output / "data/course-catalog-2026.json").exists()
print("PASS: catalog rebuild refuses to overwrite existing data")
